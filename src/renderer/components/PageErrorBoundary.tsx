import { Component, type ErrorInfo, type ReactNode } from 'react';
import { client } from '../api/client';

/** 源数据或界面异常只影响当前页，不再使整个窗口空白。 */
export default class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    void client.winReportError(`${error.name}: ${error.message}\n${info.componentStack || ''}`).catch(() => undefined);
  }
  render() {
    if (this.state.failed) return <div className="empty" role="alert" style={{ padding: 32 }}>
      <p>当前页面加载异常，错误已记录。其他窗口与播放不受影响。</p>
      <button onClick={() => this.setState({ failed: false })}>重新加载当前页</button>
    </div>;
    return this.props.children;
  }
}
