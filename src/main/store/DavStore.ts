// src/main/store/DavStore.ts — WebDAV 服务器与凭据管理。
// 物理文件：<userData>/webdav-servers.json；密码经 DriveCodec.encode 加密（宿主注入 Electron safeStorage=DPAPI），
// 读取时解密回明文（仅内存），与 DriveStore（网盘 token）同机制、同安全口径。
import type { JsonStore } from './JsonStore';
import type { Logger } from '../../shared/types';
import type { DriveCodec } from './DriveStore';
import type { DavServer } from '../../shared/webdav';

const DAV_KEY = 'servers';

/** 落盘形态（password 可能是 `enc:` 密文或旧明文） */
interface DavStored {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
}

export class DavStore {
  private data: DavStored[] = [];
  private decoded: DavServer[] | null = null;

  constructor(private store: JsonStore, private logger: Logger, private codec?: DriveCodec) {
    const raw = this.store.getObject<DavStored[] | null>(DAV_KEY, null);
    if (Array.isArray(raw)) {
      this.data = raw
        .filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id)
        .map((s) => ({
          id: String(s.id),
          name: String(s.name ?? ''),
          url: String(s.url ?? ''),
          username: String(s.username ?? ''),
          password: String(s.password ?? ''),
        }));
    }
  }

  /** 明文列表（内存态，供配置页回显与 /play 注入认证） */
  list(): DavServer[] {
    if (this.decoded) return this.decoded.map((s) => ({ ...s }));
    const out: DavServer[] = [];
    for (const s of this.data) {
      const plain = this.decodeValue(s.password);
      if (plain === null) {
        // 解密失败（换机/凭据失效）→ 依然返回条目（用户可重新填密码），密码留空
        this.logger.w(`webdav: 「${s.name || s.id}」密码解密失败，请重新填写`);
      }
      out.push({ id: s.id, name: s.name, url: s.url, username: s.username, password: plain ?? '' });
    }
    this.decoded = out;
    return out.map((s) => ({ ...s }));
  }

  get(id: string): DavServer | null {
    return this.list().find((s) => s.id === id) ?? null;
  }

  /** 新增或更新（id 为空 → 生成）；返回落库后的条目（含明文密码） */
  set(server: DavServer): DavServer {
    const name = (server.name || '').trim() || '未命名存储';
    const url = (server.url || '').trim();
    if (!url) throw new Error('服务器地址不能为空');
    if (!/^https?:\/\//i.test(url)) throw new Error('服务器地址需以 http:// 或 https:// 开头');
    const id = (server.id || '').trim() || `dav-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const stored: DavStored = {
      id,
      name,
      url,
      username: (server.username || '').trim(),
      password: this.codec ? this.codec.encode(server.password || '') : server.password || '',
    };
    const i = this.data.findIndex((s) => s.id === id);
    if (i >= 0) this.data[i] = stored;
    else this.data.push(stored);
    this.persist();
    return { id, name, url, username: stored.username, password: server.password || '' };
  }

  remove(id: string): void {
    this.data = this.data.filter((s) => s.id !== id);
    this.persist();
  }

  private decodeValue(v: string | undefined): string | null {
    if (v == null) return null;
    if (!this.codec) return v;
    return this.codec.decode(v);
  }

  private persist(): void {
    this.decoded = null;
    this.store.setObject(DAV_KEY, this.data);
    this.store.flush();
  }
}
