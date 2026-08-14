declare module 'wake_on_lan' {
  type WakeOptions = {
    address?: string
    port?: number
    num_packets?: number
    interval?: number
  }

  function wake(mac: string, options?: WakeOptions, callback?: (error?: Error) => void): void
  export default { wake }
}
