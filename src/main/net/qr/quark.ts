// src/main/net/qr/quark.ts — 夸克网盘扫码适配器（CAS 协议，复用 casQr）。
// 端点/参数来源：woleigedouer/cookie-butler config/platforms.json + lib/platforms/quark.js（未实测真实网络）。
import { makeCasAdapter } from './casQr';

export const quarkAdapter = makeCasAdapter({
  provider: 'quark',
  casBase: 'https://uop.quark.cn/cas/ajax',
  clientId: '532',
  version: '1.2',
  qrUrlTemplate: 'https://su.quark.cn/4_eMHBJ?token={token}&client_id={clientId}&ssb=weblogin',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/72.0.3626.81 Safari/537.36 SE 2.X MetaSr 1.0',
  accountInfo: 'https://pan.quark.cn/account/info',
  cloudApi: 'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/dir',
  cloudApiMethod: 'get',
  cloudApiQuery: { pr: 'ucpro', fr: 'pc', uc_param_str: '', aver: '1' },
});
