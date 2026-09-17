// utils.js —— 自研「常用子集」实现（覆盖原 QuickJS 字节码，恢复 JS 蜘蛛对 utils 的 require）。
//
// ★ 诚实说明：原 `utils.js` 是打包者用 QuickJS 编译的 //bb 字节码，Node/VM 无法执行，
//   JS 蜘蛛 `$.require('utils.js')` 因此一直报 UNSUPPORTED_BYTECODE。本实现依据字节码
//   头部可读符号表（getSize/removeExt/jsonParse/debug/isVideoFormat + 视频扩展正则）与
//   TVBox 生态常见用法还原的「常用子集」，**非 1:1**；蜘蛛若调用本实现未覆盖的函数，
//   会得到 undefined（后续调用按需补充）。
//
// 模块形态：CommonJS（module.exports = Utils），同时挂 globalThis.Utils 供全局引用。

(function () {
  var VIDEO_RE = /\.(m3u8|mp4|flv|avi|mkv|rm|wmv|mpg|m4a|mp3)(\?.*)?$/i;

  var Utils = {
    /** 字节数 → 人类可读大小（B/KB/MB/GB/TB，保留一位小数） */
    getSize: function (bytes) {
      var n = Number(bytes) || 0;
      if (n < 1024) return n + ' B';
      var units = ['KB', 'MB', 'GB', 'TB'];
      for (var i = 0; i < units.length; i++) {
        n = n / 1024;
        if (n < 1024) return n.toFixed(1) + ' ' + units[i];
      }
      return n.toFixed(1) + ' PB';
    },

    /** 去除 url 尾部的文件扩展名（含查询串处理） */
    removeExt: function (url) {
      if (!url) return '';
      return String(url).replace(VIDEO_RE, '').replace(/\.[a-zA-Z0-9]{2,5}$/, '');
    },

    /** 判断 url 是否为视频直链（常见容器格式） */
    isVideoFormat: function (url) {
      return VIDEO_RE.test(String(url || ''));
    },

    /** 安全 JSON.parse；失败返回 def（缺省 null） */
    jsonParse: function (text, def) {
      if (text == null) return def === undefined ? null : def;
      try {
        return JSON.parse(String(text));
      } catch (e) {
        return def === undefined ? null : def;
      }
    },

    /** 相对/协议相对 url → 绝对（基于 base） */
    getFullUrl: function (base, rel) {
      if (/^https?:\/\//i.test(String(rel || ''))) return rel;
      try {
        return new URL(String(rel || ''), String(base || '')).href;
      } catch (e) {
        return rel || '';
      }
    },

    /** 占位：保持与字节码同名 API 存在，避免蜘蛛调用报错 */
    debug: function () {}
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Utils;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.Utils = Utils;
  }
})();