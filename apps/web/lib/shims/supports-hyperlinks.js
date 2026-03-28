/** Browser shim - hyperlinks are handled by xterm's WebLinksAddon instead. */
module.exports = {
  supportsHyperlink: () => false,
  stdout: false,
  stderr: false,
}
