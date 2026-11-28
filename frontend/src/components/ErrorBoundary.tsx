import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Copy, Home, RefreshCw } from "lucide-react";
import "./ErrorBoundary.css";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  details: string;
  copied: boolean;
}

function errorDetails(error: Error, info?: ErrorInfo): string {
  return [
    `错误：${error.message}`,
    error.stack ? `调用栈：\n${error.stack}` : "",
    info?.componentStack ? `组件位置：\n${info.componentStack}` : "",
  ].filter(Boolean).join("\n\n");
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, details: "", copied: false };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, details: errorDetails(error), copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ details: errorDetails(error, info) });
  }

  async copyDetails() {
    const { details, error } = this.state;
    const text = details || (error ? errorDetails(error) : "未知错误");
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 1600);
    } catch {
      this.setState({ copied: false });
    }
  }

  render() {
    const { error, copied, details } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="error-boundary" role="alert">
        <section className="error-boundary__card" aria-labelledby="error-boundary-title">
          <span className="error-boundary__icon" aria-hidden="true"><AlertTriangle size={24} strokeWidth={1.8} /></span>
          <h1 id="error-boundary-title">页面刚才出错了</h1>
          <p>你的房间数据没有丢。可以刷新页面重试；如果反复出现，请把错误详情发给维护者。</p>
          <div className="error-boundary__actions">
            <button type="button" className="error-boundary__button error-boundary__button--primary" onClick={() => window.location.reload()}>
              <RefreshCw size={15} strokeWidth={1.9} />刷新页面
            </button>
            <a className="error-boundary__button" href="/home">
              <Home size={15} strokeWidth={1.9} />返回房间列表
            </a>
            <button type="button" className="error-boundary__button" onClick={() => void this.copyDetails()}>
              <Copy size={15} strokeWidth={1.9} />{copied ? "已复制" : "复制错误详情"}
            </button>
          </div>
          <details className="error-boundary__details">
            <summary>查看技术详情</summary>
            <pre>{details || error.message}</pre>
          </details>
        </section>
      </main>
    );
  }
}
