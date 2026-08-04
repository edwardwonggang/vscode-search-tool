Place a Linux x86_64 fast-grep (fast-grep-rust, binary name fgr) static/musl binary here, named:
  fgr
The extension uploads it to the server as /tmp/ripgreptool-fgr when indexed content search
(ripgrepTool.indexedContentSearch) is enabled and the binary is not already in PATH.
Current version: fast-grep 0.3.1 (https://github.com/gmilano/fast-grep-rust), MIT license.
If you omit this file, indexed search requires "fgr" in the remote PATH.
