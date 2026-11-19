// The Tauri IPC transport of a macOS app page: every call is one `window.ipc.postMessage` (a WKScriptMessage), never
// a `fetch` to ipc://localhost. The envelope and `processIpcMessage` are tauri 2.12.5's own: the postMessage branch
// of scripts/ipc-protocol.js and scripts/process-ipc-message-fn.js (Copyright 2019-2024 Tauri Programme within The
// Commons Conservancy, Apache-2.0 OR MIT). `tauri::Builder::invoke_system` puts the invoke key in the token below.
;(function () {
  const __TAURI_INVOKE_KEY__ = __INVOKE_KEY__

  const processIpcMessage = function (message) {
    if (
      message instanceof ArrayBuffer
      || ArrayBuffer.isView(message)
      || Array.isArray(message)
    ) {
      return {
        contentType: 'application/octet-stream',
        data: message
      }
    } else {
      const data = JSON.stringify(message, (_k, val) => {
        const SERIALIZE_TO_IPC_FN = '__TAURI_TO_IPC_KEY__'

        if (val instanceof Map) {
          return Object.fromEntries(val.entries())
        } else if (val instanceof Uint8Array) {
          return Array.from(val)
        } else if (val instanceof ArrayBuffer) {
          return Array.from(new Uint8Array(val))
        } else if (
          typeof val === 'object'
          && val !== null
          && SERIALIZE_TO_IPC_FN in val
        ) {
          return val[SERIALIZE_TO_IPC_FN]()
        } else {
          return val
        }
      })

      return {
        contentType: 'application/json',
        data
      }
    }
  }

  function sendIpcMessage(message) {
    const { cmd, callback, error, payload, options } = message
    const { data } = processIpcMessage({
      cmd,
      callback,
      error,
      options: {
        ...options,
        customProtocolIpcBlocked: true
      },
      payload,
      __TAURI_INVOKE_KEY__
    })
    window.ipc.postMessage(data)
  }

  Object.defineProperty(window.__TAURI_INTERNALS__, 'postMessage', {
    value: sendIpcMessage
  })
})()
