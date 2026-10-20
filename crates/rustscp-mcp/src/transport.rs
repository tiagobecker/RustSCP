//! MCP stdio transport: newline-delimited JSON-RPC 2.0 messages over any byte stream.
//!
//! Each message is one line of UTF-8 JSON without embedded newlines. Requests run
//! concurrently (a write waiting for approval never blocks a `ping` or a read), replies
//! are written whole, one per line, and nothing else is ever written to the stream. A
//! `notifications/cancelled` drops the named request, which then gets no reply.

use crate::protocol::JsonRpcResponse;
use crate::rpc::{
    cancellable_request, cancelled_requests, parse_message, RpcSession, ToolBackend,
    INVALID_REQUEST, PARSE_ERROR,
};
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Semaphore};
use tokio::task::{AbortHandle, JoinSet};

/// Largest message accepted (a base64 `fs_write_file` of several MiB must fit).
pub const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
/// Requests handled at the same time on one stream; further lines wait to be read.
pub const MAX_CONCURRENT_REQUESTS: usize = 16;
/// After the client closes its end, requests still running get this long to answer.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Outcome of reading one newline-delimited frame.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Frame {
    /// A complete line is in the buffer (without the `\n`).
    Line,
    /// The line was longer than the limit and was skipped.
    TooLong,
    /// The stream ended.
    Eof,
}

/// Reads the next `\n`-terminated line into `buf` without ever holding more than `max`
/// bytes of it; a final line without a newline still counts.
pub(crate) async fn read_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
) -> io::Result<Frame> {
    buf.clear();
    let mut too_long = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if too_long {
                Frame::TooLong
            } else if buf.is_empty() {
                Frame::Eof
            } else {
                Frame::Line
            });
        }
        let newline = available.iter().position(|&b| b == b'\n');
        let chunk = &available[..newline.unwrap_or(available.len())];
        if !too_long {
            if buf.len() + chunk.len() > max {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(chunk);
            }
        }
        let consumed = newline.map_or(available.len(), |i| i + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(if too_long {
                Frame::TooLong
            } else {
                Frame::Line
            });
        }
    }
}

/// Writes each queued message as one line and flushes it.
pub(crate) async fn write_lines<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut lines: mpsc::Receiver<String>,
) -> io::Result<()> {
    while let Some(line) = lines.recv().await {
        debug_assert!(!line.contains('\n'));
        writer.write_all(line.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
    }
    Ok(())
}

fn error_line(code: i32, message: &str) -> String {
    serde_json::to_string(&JsonRpcResponse::error(Value::Null, code, message)).unwrap_or_default()
}

/// Serves MCP over `reader`/`writer` until the client closes `reader`. Requests still
/// running then get [`SHUTDOWN_GRACE`] to finish before they are dropped.
pub async fn serve<R, W, B>(reader: R, writer: W, session: Arc<RpcSession<B>>) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    B: ToolBackend + ?Sized + 'static,
{
    let (tx, rx) = mpsc::channel::<String>(MAX_CONCURRENT_REQUESTS * 2);
    let mut writer_task = tokio::spawn(write_lines(writer, rx));
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS));
    let mut in_flight = JoinSet::new();
    // Running requests by JSON-RPC id, for `notifications/cancelled`.
    let mut cancellable: HashMap<String, AbortHandle> = HashMap::new();
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();

    let read_result = loop {
        // Reap finished requests so neither the set nor the map grows with the session.
        while in_flight.try_join_next().is_some() {}
        cancellable.retain(|_, task| !task.is_finished());

        let frame = tokio::select! {
            frame = read_frame(&mut reader, &mut buf, MAX_MESSAGE_BYTES) => frame,
            // The writer only stops early when the client's end can no longer be written.
            written = &mut writer_task => {
                return match written {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(e)) => Err(e),
                    Err(e) => Err(io::Error::other(e)),
                };
            }
        };
        match frame {
            Ok(Frame::Eof) => break Ok(()),
            Ok(Frame::TooLong) => {
                let msg = format!("Invalid Request: message larger than {MAX_MESSAGE_BYTES} bytes");
                if tx.send(error_line(INVALID_REQUEST, &msg)).await.is_err() {
                    break Ok(());
                }
            }
            Ok(Frame::Line) => {
                let Ok(text) = std::str::from_utf8(&buf) else {
                    if tx
                        .send(error_line(PARSE_ERROR, "Parse error: message is not UTF-8"))
                        .await
                        .is_err()
                    {
                        break Ok(());
                    }
                    continue;
                };
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let message = match parse_message(text) {
                    Ok(message) => message,
                    Err(reply) => {
                        if tx.send(reply).await.is_err() {
                            break Ok(());
                        }
                        continue;
                    }
                };
                // A cancelled request is dropped and never answered: a write waiting for
                // approval is withdrawn, one already approved still finishes.
                for id in cancelled_requests(&message) {
                    if let Some(task) = cancellable.remove(&id) {
                        task.abort();
                    }
                }
                let key = cancellable_request(&message);
                if !session.is_initialized() || (key.is_none() && !message.is_array()) {
                    // Before `initialize` is answered, one message at a time. Notifications
                    // and malformed messages are handled at once, never queued.
                    if let Some(reply) = session.handle_value(message).await {
                        if tx.send(reply).await.is_err() {
                            break Ok(());
                        }
                    }
                    continue;
                }
                let Ok(permit) = permits.clone().acquire_owned().await else {
                    break Ok(());
                };
                let session = session.clone();
                let tx = tx.clone();
                let task = in_flight.spawn(async move {
                    if let Some(reply) = session.handle_value(message).await {
                        let _ = tx.send(reply).await;
                    }
                    drop(permit);
                });
                if let Some(key) = key {
                    cancellable.insert(key, task);
                }
            }
            Err(e) => break Err(e),
        }
    };

    // The client closed its end: let running requests answer, then stop.
    let drained = tokio::time::timeout(SHUTDOWN_GRACE, async {
        while in_flight.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        in_flight.abort_all();
    }
    drop(tx);
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, writer_task).await;
    read_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::McpToolResult;
    use async_trait::async_trait;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt};

    /// `slow` waits until `release` is notified, everything else answers at once.
    #[derive(Default)]
    struct GateBackend {
        release: tokio::sync::Notify,
        agents: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ToolBackend for GateBackend {
        async fn call_tool(&self, agent: &str, name: &str, _args: &Value) -> McpToolResult {
            self.agents.lock().unwrap().push(agent.to_string());
            if name == "slow" {
                self.release.notified().await;
            }
            McpToolResult::success_text(name)
        }
    }

    /// Notifies when dropped.
    struct OnDrop<'a>(&'a tokio::sync::Notify);

    impl Drop for OnDrop<'_> {
        fn drop(&mut self) {
            self.0.notify_one();
        }
    }

    /// `hang` never finishes; `started` and `dropped` track it.
    #[derive(Default)]
    struct HangingBackend {
        started: tokio::sync::Notify,
        dropped: tokio::sync::Notify,
    }

    #[async_trait]
    impl ToolBackend for HangingBackend {
        async fn call_tool(&self, _agent: &str, name: &str, _args: &Value) -> McpToolResult {
            if name == "hang" {
                let _dropped = OnDrop(&self.dropped);
                self.started.notify_one();
                std::future::pending::<()>().await;
            }
            McpToolResult::success_text(name)
        }
    }

    async fn within<F: std::future::Future>(what: &str, future: F) -> F::Output {
        tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
    }

    async fn next_json<R: AsyncBufRead + Unpin>(lines: &mut tokio::io::Lines<R>) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
            .await
            .expect("a reply in time")
            .unwrap()
            .expect("a line");
        assert!(!line.contains('\n'));
        serde_json::from_str(&line).unwrap()
    }

    #[tokio::test]
    async fn read_frame_handles_crlf_partial_and_oversized_lines() {
        let data = b"{\"a\":1}\r\n\n0123456789abcdef\nlast";
        let mut reader = BufReader::with_capacity(4, &data[..]);
        let mut buf = Vec::new();
        assert_eq!(
            read_frame(&mut reader, &mut buf, 10).await.unwrap(),
            Frame::Line
        );
        assert_eq!(buf, b"{\"a\":1}\r");
        assert_eq!(
            read_frame(&mut reader, &mut buf, 10).await.unwrap(),
            Frame::Line
        );
        assert!(buf.is_empty());
        assert_eq!(
            read_frame(&mut reader, &mut buf, 10).await.unwrap(),
            Frame::TooLong
        );
        assert!(buf.is_empty());
        assert_eq!(
            read_frame(&mut reader, &mut buf, 10).await.unwrap(),
            Frame::Line
        );
        assert_eq!(buf, b"last");
        assert_eq!(
            read_frame(&mut reader, &mut buf, 10).await.unwrap(),
            Frame::Eof
        );
    }

    #[tokio::test]
    async fn stdio_session_answers_line_by_line_and_concurrently() {
        let backend = Arc::new(GateBackend::default());
        let session = Arc::new(RpcSession::new(backend.clone(), "mcp-stdio", Some("stdio")));
        let (client, server) = duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server);
        let served = tokio::spawn(serve(server_read, server_write, session));

        let (client_read, mut client_write) = tokio::io::split(client);
        let mut lines = BufReader::new(client_read).lines();

        client_write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"clientInfo\":{\"name\":\"test\"}}}\n")
            .await
            .unwrap();
        let init = next_json(&mut lines).await;
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");

        // A notification gets nothing back; a slow call does not hold up the next request.
        client_write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"slow\"}}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n")
            .await
            .unwrap();
        let ping = next_json(&mut lines).await;
        assert_eq!(ping["id"], 3);
        backend.release.notify_one();
        let slow = next_json(&mut lines).await;
        assert_eq!(slow["id"], 2);
        assert_eq!(slow["result"]["content"][0]["text"], "slow");

        // Invalid JSON and non-UTF-8 lines get errors and the stream keeps working.
        client_write
            .write_all(b"not json\n\xff\xfe\n")
            .await
            .unwrap();
        assert_eq!(next_json(&mut lines).await["error"]["code"], PARSE_ERROR);
        assert_eq!(next_json(&mut lines).await["error"]["code"], PARSE_ERROR);
        client_write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/list\"}\n")
            .await
            .unwrap();
        let list = next_json(&mut lines).await;
        assert_eq!(list["id"], 4);
        assert!(list["result"]["tools"].as_array().unwrap().len() >= 5);

        // Closing stdin ends the session cleanly.
        client_write.shutdown().await.unwrap();
        drop(client_write);
        tokio::time::timeout(Duration::from_secs(5), served)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn cancelled_requests_are_dropped_and_never_answered() {
        let backend = Arc::new(HangingBackend::default());
        let session = Arc::new(RpcSession::new(backend.clone(), "mcp-stdio", Some("stdio")));
        let (client, server) = duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server);
        let served = tokio::spawn(serve(server_read, server_write, session));
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut lines = BufReader::new(client_read).lines();

        client_write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n")
            .await
            .unwrap();
        assert_eq!(next_json(&mut lines).await["id"], 1);

        // Two calls that never finish: id 2 and id "2" are different requests.
        client_write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"hang\"}}\n")
            .await
            .unwrap();
        within("call 2", backend.started.notified()).await;
        client_write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"method\":\"tools/call\",\"params\":{\"name\":\"hang\"}}\n")
            .await
            .unwrap();
        within("call \"2\"", backend.started.notified()).await;

        // Cancelling an unknown id does nothing; cancelling "2" drops only that call.
        client_write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":99}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":\"2\",\"reason\":\"user\"}}\n")
            .await
            .unwrap();
        within("call \"2\" to be dropped", backend.dropped.notified()).await;
        client_write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n")
            .await
            .unwrap();
        assert_eq!(next_json(&mut lines).await["id"], 3);

        // A cancellation inside a batch counts too.
        client_write
            .write_all(b"[{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":2}}]\n")
            .await
            .unwrap();
        within("call 2 to be dropped", backend.dropped.notified()).await;

        // Nothing is left running, so closing stdin ends the session at once, and no reply
        // for either cancelled call was ever written.
        client_write.shutdown().await.unwrap();
        within("the session to end", served).await.unwrap().unwrap();
        assert!(lines.next_line().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn piped_requests_wait_for_initialize_and_answer_before_exit() {
        let backend = Arc::new(GateBackend::default());
        let session = Arc::new(RpcSession::new(backend.clone(), "mcp-stdio", Some("stdio")));
        // Everything arrives at once and stdin closes right after (`printf ... | server`).
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"piped\"}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"fast\"}}\n",
        );
        let (out_server, out_client) = duplex(64 * 1024);
        serve(input.as_bytes(), out_server, session).await.unwrap();
        let mut lines = BufReader::new(out_client).lines();
        assert_eq!(next_json(&mut lines).await["id"], 1);
        let reply = next_json(&mut lines).await;
        assert_eq!(reply["id"], 2);
        assert_eq!(reply["result"]["content"][0]["text"], "fast");
        assert_eq!(
            *backend.agents.lock().unwrap(),
            vec!["piped (stdio)".to_string()]
        );
    }
}
