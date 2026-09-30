// src/renderer/pages/AboutPage.tsx
// ★ 2026-09-28（用户要求）：新增「说明」页 —— 详细版免责声明 + GitHub / 爱发电入口。
//   链接一律走 window.open：主进程 setWindowOpenHandler 会拦截并交给系统浏览器（shell.openExternal），
//   不在应用内加载任何外部页面。

/** 项目主页（源码 / 更新发布） */
const GITHUB_URL = 'https://github.com/yagami-hue/Win-box';
/** 爱发电赞助页（完全自愿；不提供任何额外功能） */
const AFDIAN_URL = 'https://afdian.com/a/WinBox';

function openExternal(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export default function AboutPage() {
  return (
    <>
      <div className="topbar">
        <h2 style={{ margin: 0, fontSize: 16 }}>说明 · 免责声明</h2>
      </div>
      <div className="content about">
        <section className="about-sec">
          <h3>一、软件性质</h3>
          <p>
            Win-Box 是一个<b>开源（Open Source）学习项目</b>，本质上只是一个<b>通用的影片播放工具</b>（播放器外壳）：
            不含任何盈利行为，不提供服务、不存储、不推送任何影视资源与内容，主要用途是个人学习研究，
            尤其是「Vibe Coding」编程体验。
          </p>
        </section>

        <section className="about-sec">
          <h3>二、不提供、不存储、不分发任何内容</h3>
          <p>
            软件<b>不内置任何影视资源索引、不运营任何内容服务器</b>：你在使用过程中自行配置 / 导入的播放源、直播源、
            弹幕与字幕接口、网盘凭据与内容，全部来自<b>第三方</b>，与本软件及作者无关。
          </p>
          <p>
            软件内的本地代理（<span className="muted">127.0.0.1</span>）仅用于把你自己设备上的播放请求转发给上述第三方，
            属于纯本机播放链路，不构成对任何内容的托管、缓存或再分发。
          </p>
        </section>

        <section className="about-sec">
          <h3>三、与第三方无隶属关系</h3>
          <p>
            本软件与任何影视平台、内容站点、网盘服务、TVBox / CatVod 及其发行方<b>均无隶属、合作、代理或授权关系</b>；
            相关名称与商标归各自权利人所有，仅用于客观描述兼容性。
          </p>
        </section>

        <section className="about-sec">
          <h3>四、使用者责任</h3>
          <p>
            你应确保自己导入的第三方源与使用行为<b>符合你所在地区的法律法规</b>，并对使用本软件产生的一切后果负责；
            请勿用于传播、观看任何违法或侵权内容。若你不接受上述约定，请立即停止使用并删除本软件。
          </p>
        </section>

        <section className="about-sec">
          <h3>五、知识产权与权利通知</h3>
          <p>
            本软件仅提供播放工具，<b>不对任何第三方内容主张权利，也未从任何第三方内容中获利</b>。
            若权利人认为本项目的某个行为可能涉及侵权，欢迎通过下方 GitHub 主页的 Issues 联系作者，
            作者将及时核实并配合处理（包括但不限于移除相关内容、停止分发）。
          </p>
        </section>

        <section className="about-sec">
          <h3>六、无担保声明</h3>
          <p>
            本软件按<b>「现状」</b>提供，不附带任何明示或默示的担保（包括但不限于可用性、适用性与无侵权保证）。
            作者不对使用或无法使用本软件所导致的任何直接或间接损失承担责任。
          </p>
        </section>

        <section className="about-sec">
          <h3>七、开源主页与赞助（自愿）</h3>
          <p>
            源码、更新与问题反馈见 GitHub 主页；如果你愿意支持作者持续维护，可通过爱发电赞助。
          </p>
          <div className="about-links">
            <button className="about-link" onClick={() => openExternal(GITHUB_URL)} title={GITHUB_URL}>
              <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              <span>GitHub 主页</span>
            </button>
            <button className="about-link about-sponsor" onClick={() => openExternal(AFDIAN_URL)} title={AFDIAN_URL}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 20.2s-7.2-4.5-7.2-10A4.6 4.6 0 0112 7.1a4.6 4.6 0 017.2 3.1c0 5.5-7.2 10-7.2 10z" />
              </svg>
              <span>爱发电 · 赞助</span>
            </button>
          </div>
          <p className="muted">
            赞助<b>完全自愿</b>，仅用于支持作者在开发与维护上投入的时间与精力；<b>不会获得任何额外功能、内容、权限或服务</b>，
            也不改变软件的任何行为 —— 不赞助同样可以使用全部功能。
          </p>
          <p className="muted">
            本软件不含任何付费内容、会员或解锁机制；赞助与任何第三方内容、平台亦无关联，不构成对任何内容的购买或授权。
          </p>
        </section>
      </div>
    </>
  );
}