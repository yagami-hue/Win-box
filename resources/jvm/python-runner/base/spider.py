# -*- coding: utf-8 -*-
# base.spider —— .py 蜘蛛基类（CPython3 版，桌面端经嵌入式 Python 运行）。
# 对齐上游 Box pyramid（.tmp/box-src/Box-main/pyramid/src/python/base/spider.py）核心
# 调用面：kkys 类蜘蛛通过 `from base.spider import Spider` 继承，依赖：
#   - self.fetch(url, headers=..., timeout=..., verify=False) → requests.Response（.text/.raw/.status_code/.close/.encoding）
#   - self.html(content) → lxml etree（HTML 解析；_html 类蜘蛛常自行实现）
#   - regStr / str2json / json2str / getProxyUrl 等工具
# 运行时自带 requests/urllib3/lxml 到 site-packages（见 JarSpiderBridge.ensureRuntimeLibs）。

from urllib.parse import quote
import json
import re

import requests
import urllib3  # noqa: F401  与源内 `import urllib3` 对齐（可选，装了即用）
urllib3.disable_warnings()


class Spider:
    def __init__(self):
        self.extend = ''

    def init(self, extend=""):
        pass

    def homeContent(self, filter):
        return {"class": [], "list": []}

    def homeVideoContent(self):
        return {"list": []}

    def categoryContent(self, tid, pg, filter, extend):
        return {"page": pg, "pagecount": 1, "limit": 0, "total": 0, "list": []}

    def detailContent(self, ids):
        return {"list": []}

    def searchContent(self, key, quick, pg="1"):
        return {"list": [], "page": 1}

    def playerContent(self, flag, id, vipFlags):
        return {}

    def liveContent(self, url):
        return {}

    def localProxy(self, param):
        return None

    def isVideoFormat(self, url):
        return False

    def manualVideoCheck(self):
        return False

    def destroy(self):
        pass

    def getName(self):
        return ""

    # ---- 网络（requests 直连；桌面端无系统拼装/代理差异） ----
    def fetch(self, url, params=None, cookies=None, headers=None, timeout=5, verify=False, stream=False,
              allow_redirects=True):
        resp = requests.get(url, params=params, cookies=cookies, headers=headers, timeout=timeout, verify=verify,
                            stream=stream, allow_redirects=allow_redirects)
        resp.encoding = 'utf-8'
        return resp

    def post(self, url, params=None, data=None, json=None, cookies=None, headers=None, timeout=5, verify=False,
             stream=False, allow_redirects=True):
        resp = requests.post(url, params=params, data=data, json=json, cookies=cookies, headers=headers,
                             timeout=timeout, verify=verify, stream=stream, allow_redirects=allow_redirects)
        resp.encoding = 'utf-8'
        return resp

    def html(self, content):
        from lxml import etree
        return etree.HTML(content.encode('utf-8') if isinstance(content, str) else content)

    def regStr(self, reg, src, group=1):
        m = re.search(reg, src)
        return m.group(group) if m else ''

    def removeHtmlTags(self, src):
        return re.sub('<.*?>', '', src)

    def cleanText(self, src):
        return re.sub(r'[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF]', '',
                      src)

    def str2json(self, s):
        return json.loads(s)

    def json2str(self, o):
        return json.dumps(o, ensure_ascii=False)

    def getProxyUrl(self, local=True):
        return '%s?do=py' % self._proxy_base()

    def _proxy_base(self):
        return 'http://127.0.0.1:9978'

    def log(self, msg):
        if isinstance(msg, (dict, list)):
            print(json.dumps(msg, ensure_ascii=False))
        else:
            print(msg)