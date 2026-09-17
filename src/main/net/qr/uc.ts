// src/main/net/qr/uc.ts — UC 网盘扫码适配器（CAS 协议，复用 casQr）。
// 与夸克同协议，仅域名/client_id/二维码模板/Referer/云盘 API 不同（避免复制粘贴）。
// 端点/参数来源：woleigedouer/cookie-butler config/platforms.json + lib/platforms/uc.js（未实测真实网络）。
import { makeCasAdapter } from './casQr';

export const ucAdapter = makeCasAdapter({
  provider: 'uc',
  casBase: 'https://api.open.uc.cn/cas/ajax',
  clientId: '381',
  version: '1.2',
  qrUrlTemplate:
    'https://su.uc.cn/1_n0ZCv?uc_param_str=dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt&token={token}&client_id={clientId}&uc_biz_str=S%3Acustom%7CC%3Atitlebar_fix',
  referer: 'https://drive.uc.cn',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/72.0.3626.81 Safari/537.36 SE 2.X MetaSr 1.0',
  accountInfo: 'https://drive.uc.cn/account/info',
  cloudApi: 'https://pc-api.uc.cn/1/clouddrive/transfer/upload/pdir',
  cloudApiMethod: 'post',
  cloudApiQuery: { pr: 'UCBrowser', fr: 'pc' },
});
