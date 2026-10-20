//! Quoting for remote POSIX shell commands built by the core drivers.

/// Quote one value for a POSIX shell (`sh`, `bash`, `dash`, busybox `ash`).
///
/// The value is wrapped in single quotes and every `'` is encoded as `'\''`,
/// so the shell sees exactly one word with the original bytes: `$`, backticks,
/// `\`, `"`, `;`, `|`, spaces and newlines all stay literal. Every value the
/// core interpolates into a remote command goes through this function.
pub fn sh_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::sh_quote;

    #[test]
    fn quotes_single_quotes_and_metacharacters() {
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("don't"), "'don'\\''t'");
        assert_eq!(sh_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
    }

    #[cfg(unix)]
    #[test]
    fn round_trips_through_sh() {
        let nasty = "x'; echo pwned; echo '$HOME `id` \"q\" \\ \n end";
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("printf %s {}", sh_quote(nasty)))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), nasty);
    }
}
