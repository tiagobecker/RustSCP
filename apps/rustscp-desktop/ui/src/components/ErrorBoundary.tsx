import { Component, ErrorInfo, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import i18next from 'i18next';
import { AlertTriangle, Check, Copy, RotateCw } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure } from './ui/controls.tsx';
import { copyText } from './copyToClipboard.ts';

interface Props {
  children: ReactNode;
  /** Title of the fallback. For 'section'/'modal' scopes this names the broken part (e.g. "Sync assistant"). */
  fallbackTitle?: string;
  /**
   * 'app' (default): full-window fallback for the root boundary.
   * 'section': a compact card shown in place of a pane or panel.
   * 'modal': the fallback is shown in a dialog, so one broken modal does not take the whole app down.
   */
  scope?: 'app' | 'section' | 'modal';
  /** Closes the broken modal or pane ('section'/'modal' scopes). */
  onClose?: () => void;
  /** When any of these values change, a caught error is cleared and the children are rendered again. */
  resetKeys?: unknown[];
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  copyState: 'idle' | 'copied' | 'failed';
}

const isPortuguese = () => {
  const lang = i18next.language || (typeof document !== 'undefined' ? document.documentElement.lang : '') || (typeof navigator !== 'undefined' ? navigator.language : '');
  return (lang || '').toLowerCase().startsWith('pt');
};

const keysChanged = (a: unknown[] = [], b: unknown[] = []) => a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    copyState: 'idle',
  };

  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('RustSCP Uncaught UI Error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  public componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && keysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  public componentWillUnmount() {
    if (this.copyTimer) clearTimeout(this.copyTimer);
  }

  private reset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null, copyState: 'idle' });
  };

  private handleReload = () => {
    window.location.reload();
  };

  private handleClose = () => {
    this.reset();
    this.props.onClose?.();
  };

  private handleCopyDetails = async () => {
    const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
    const build = typeof __BUILD_NUMBER__ !== 'undefined' ? __BUILD_NUMBER__ : 'unknown';
    const details = [
      'RustSCP Error Details:',
      `Version: ${version} (build ${build})`,
      `Where: ${this.props.fallbackTitle || this.props.scope || 'app'}`,
      `Time: ${new Date().toISOString()}`,
      `User Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
      `Message: ${this.state.error?.message || 'Unknown error'}`,
      `Stack: ${this.state.error?.stack || ''}`,
      `ComponentStack: ${this.state.errorInfo?.componentStack || ''}`,
    ].join('\n');

    const ok = await copyText(details);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.setState({ copyState: ok ? 'copied' : 'failed' });
    this.copyTimer = setTimeout(() => this.setState({ copyState: 'idle' }), 2000);
  };

  private renderDetails(pt: boolean) {
    const { error } = this.state;
    if (!error) return null;
    return (
      <Disclosure label={pt ? 'Detalhes técnicos' : 'Technical details'}>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-line bg-surface-sunken p-3 font-mono text-[11.5px] leading-relaxed text-ink-muted break-words select-text">
          <p className="text-ink">
            {error.name}: {error.message}
          </p>
          {error.stack && <pre className="mt-1.5 whitespace-pre-wrap text-ink-faint">{error.stack}</pre>}
        </div>
      </Disclosure>
    );
  }

  private renderCopyButton(pt: boolean) {
    const { copyState } = this.state;
    return (
      <Button
        variant="ghost"
        onClick={this.handleCopyDetails}
        icon={copyState === 'copied' ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      >
        {copyState === 'copied'
          ? pt
            ? 'Copiado'
            : 'Copied'
          : copyState === 'failed'
            ? pt
              ? 'Não foi possível copiar'
              : 'Could not copy'
            : pt
              ? 'Copiar detalhes'
              : 'Copy details'}
      </Button>
    );
  }

  public render() {
    if (!this.state.hasError) return this.props.children;

    const pt = isPortuguese();
    const scope = this.props.scope || 'app';
    const where = this.props.fallbackTitle;

    if (scope === 'modal' && typeof document !== 'undefined') {
      // Portaled like the other dialogs so a transformed ancestor cannot clip the fixed overlay
      return createPortal(
        <Modal
          isOpen
          onClose={this.handleClose}
          size="md"
          title={where ? (pt ? `Algo deu errado em ${where}` : `Something went wrong in ${where}`) : pt ? 'Algo deu errado' : 'Something went wrong'}
          icon={<AlertTriangle className="w-[18px] h-[18px] text-amber-600 dark:text-amber-400" aria-hidden="true" />}
          footer={
            <>
              <span className="mr-auto">{this.renderCopyButton(pt)}</span>
              <Button variant="secondary" onClick={this.reset} icon={<RotateCw className="w-3.5 h-3.5" />}>
                {pt ? 'Tentar novamente' : 'Try again'}
              </Button>
              <Button variant="primary" onClick={this.handleClose}>
                {pt ? 'Fechar' : 'Close'}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-[13px] text-ink-muted leading-relaxed">
              {pt
                ? 'Esta janela encontrou um problema inesperado. O restante do RustSCP e suas conexões continuam funcionando.'
                : 'This window ran into an unexpected problem. The rest of RustSCP and your connections keep working.'}
            </p>
            {this.renderDetails(pt)}
          </div>
        </Modal>,
        document.body
      );
    }

    if (scope === 'section') {
      return (
        <div role="alert" className="m-3 ui-card p-4 space-y-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-ink">
                {where ? (pt ? `Algo deu errado em ${where}` : `Something went wrong in ${where}`) : pt ? 'Algo deu errado aqui' : 'Something went wrong here'}
              </p>
              <p className="text-[12px] text-ink-muted leading-snug mt-0.5">
                {pt ? 'O restante do aplicativo continua funcionando.' : 'The rest of the app keeps working.'}
              </p>
            </div>
          </div>
          {this.renderDetails(pt)}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto">{this.renderCopyButton(pt)}</span>
            <Button size="sm" variant="secondary" onClick={this.reset} icon={<RotateCw className="w-3.5 h-3.5" />}>
              {pt ? 'Tentar novamente' : 'Try again'}
            </Button>
            {this.props.onClose && (
              <Button size="sm" variant="primary" onClick={this.handleClose}>
                {pt ? 'Fechar' : 'Close'}
              </Button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-surface text-ink flex items-center justify-center p-6 font-sans">
        <div role="alert" className="ui-card shadow-modal max-w-lg w-full p-6 space-y-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <h1 className="text-[15px] font-semibold text-ink">{where || (pt ? 'Algo deu errado' : 'Something went wrong')}</h1>
              <p className="text-[13px] text-ink-muted leading-relaxed">
                {pt
                  ? 'O RustSCP encontrou um problema inesperado na interface. Tente novamente; se continuar acontecendo, recarregue a janela.'
                  : 'RustSCP ran into an unexpected problem in the interface. Try again; if it keeps happening, reload the window.'}
              </p>
            </div>
          </div>

          {this.renderDetails(pt)}

          <p className="text-[12px] text-ink-faint leading-snug">
            {pt
              ? 'Ao recarregar, as abas abertas são fechadas. Conexões e sincronizações iniciadas antes podem continuar ativas em segundo plano até você sair do RustSCP.'
              : 'Reloading closes the open tabs. Connections and syncs started before may stay active in the background until you quit RustSCP.'}
          </p>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto">{this.renderCopyButton(pt)}</span>
            <Button variant="secondary" onClick={this.reset}>
              {pt ? 'Tentar novamente' : 'Try again'}
            </Button>
            <Button variant="primary" onClick={this.handleReload} icon={<RotateCw className="w-3.5 h-3.5" />}>
              {pt ? 'Recarregar' : 'Reload'}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
