# -*- coding: utf-8 -*-
# base.localProxy —— 与上游 Box pyramid 同协议：本地代理 URL/端口（对齐桌面端 LocalProxyServer 9978）。


class Proxy:
    def getUrl(self, local):
        return 'http://127.0.0.1:9978'

    def getPort(self):
        return 9978