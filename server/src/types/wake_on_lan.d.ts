declare module 'wake_on_lan' {
  type WakeOptions = {
    address?: string
    port?: number
  }

  function wake(mac: string, options?: WakeOptions): Promise<void>
  export default { wake }
}
