"""本地 WebDAV 测试服务端（仅用于验证扩展的 webdav 通道，不属于交付内容）"""
import os
import sys

from cheroot.wsgi import Server as WSGIServer
from wsgidav.wsgidav_app import WsgiDAVApp

root = os.path.abspath(sys.argv[1])
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8081
user = sys.argv[3] if len(sys.argv) > 3 else "tester"
pwd = sys.argv[4] if len(sys.argv) > 4 else "s3cret"

config = {
    "host": "127.0.0.1",
    "port": port,
    "provider_mapping": {"/": root},
    "http_authenticator": {
        "domain_controller": "wsgidav.dc.simple_dc.SimpleDomainController",
        "accept_basic": True,
        "accept_digest": False,
        "default_to_digest": False,
    },
    "simple_dc": {"user_mapping": {"*": {user: {"password": pwd}}}},
    "verbose": 1,
}

app = WsgiDAVApp(config)
server = WSGIServer(("127.0.0.1", port), app)
print("DAV-TEST-SERVER-READY http://127.0.0.1:%d root=%s" % (port, root), flush=True)
server.start()
