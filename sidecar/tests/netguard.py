"""Test-only network tripwire: while installed, name resolution and every
AF_INET/AF_INET6 connect or sendto raise OfflineNetworkError, so a test can
prove a toolkit path makes no network call. Process-wide; use it only in a
single-threaded test, and always uninstall in a finally."""

import socket

_saved: dict = {}


class OfflineNetworkError(ConnectionRefusedError):
    pass


def _refuse(what: str):
    def fn(*args, **kwargs):
        raise OfflineNetworkError(f"netguard: {what} attempted while the network is guarded")

    return fn


def _guard_method(name: str):
    original = getattr(socket.socket, name)

    def fn(self, *args, **kwargs):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            raise OfflineNetworkError(f"netguard: socket.{name} attempted while the network is guarded")
        return original(self, *args, **kwargs)

    return original, fn


def install() -> None:
    if _saved:
        return
    _saved["getaddrinfo"] = socket.getaddrinfo
    _saved["create_connection"] = socket.create_connection
    socket.getaddrinfo = _refuse("getaddrinfo")
    socket.create_connection = _refuse("create_connection")
    for name in ("connect", "connect_ex", "sendto"):
        original, fn = _guard_method(name)
        _saved["socket." + name] = original
        setattr(socket.socket, name, fn)


def uninstall() -> None:
    if not _saved:
        return
    socket.getaddrinfo = _saved.pop("getaddrinfo")
    socket.create_connection = _saved.pop("create_connection")
    for name in ("connect", "connect_ex", "sendto"):
        setattr(socket.socket, name, _saved.pop("socket." + name))
