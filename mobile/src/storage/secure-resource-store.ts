import type { DeletionSecureStorage } from "./account-deletion-vault"

type Slot = "a" | "b"
interface Manifest { version: 1; active: Slot | null; a: number; b: number; legacy: boolean }
const maximumChunks = 4096, chunkSize = 256
const unavailable = () => new Error("Saved sign-in information needs another attempt.")

/** Call through one serialized owner. Chunk allocation is durable BEFORE data
 * writes, so interrupted writes and removals remain discoverable after restart.
 * Only the committed slot is readable; a retired slot never revives old data.
 * SecureStore encrypts every value. This does not promise forensic erasure. */
export class SecureResourceStore {
  constructor(private readonly storage: DeletionSecureStorage) {}
  private prefix(key: string) {
    if (!/^[A-Za-z0-9_.-]{1,500}$/.test(key)) throw unavailable()
    return `${key}.cyntch-v1`
  }
  private async manifest(prefix: string): Promise<Manifest | null> {
    const raw = await this.storage.get(`${prefix}.manifest`)
    if (raw === null) return null
    try {
      if (raw.length > 200) throw unavailable()
      const value = JSON.parse(raw) as Manifest
      if (value.version !== 1 || ![null,"a","b"].includes(value.active) || typeof value.legacy !== "boolean" || (value.legacy && value.active !== null) ||
        [value.a,value.b].some(count => !Number.isInteger(count) || count < 0 || count > maximumChunks)) throw unavailable()
      if (value.active && value[value.active] === 0) throw unavailable()
      return {version:1,active:value.active,a:value.a,b:value.b,legacy:value.legacy}
    } catch {throw unavailable()}
  }
  private save(prefix: string, state: Manifest) { return this.storage.set(`${prefix}.manifest`,JSON.stringify(state)) }
  private async collect(prefix: string, state: Manifest) {
    for (const slot of ["a","b"] as const) {
      if (state.active === slot || !state[slot]) continue
      for (let index=0;index<state[slot];index++) await this.storage.remove(`${prefix}.${slot}.${index}`)
      state = {...state,[slot]:0}
      await this.save(prefix,state)
    }
    return state
  }
  async read(key: string): Promise<{value: string | null; legacy: boolean}> {
    const prefix = this.prefix(key), saved = await this.manifest(prefix)
    if (!saved) return {value:await this.readLegacy(key),legacy:true}
    const state = await this.collect(prefix,saved)
    if (state.legacy) return {value:await this.readLegacy(key),legacy:true}
    if (!state.active) return {value:null,legacy:false}
    let value = ""
    for (let index=0;index<state[state.active];index++) {
      const chunk = await this.storage.get(`${prefix}.${state.active}.${index}`)
      if (chunk === null) {await this.write(key,null);return {value:null,legacy:false}}
      value += chunk
    }
    return {value,legacy:false}
  }
  async write(key: string, value: string | null) {
    const prefix = this.prefix(key)
    let state = await this.collect(prefix,await this.manifest(prefix) ?? {version:1,active:null,a:0,b:0,legacy:true})
    if (!value) {
      state = {...state,active:null,legacy:false}
      await this.save(prefix,state)
    } else {
      if (value.length > maximumChunks * chunkSize) throw unavailable()
      const characters = Array.from(value), chunks: string[] = []
      for (let index=0;index<characters.length;index+=chunkSize) chunks.push(characters.slice(index,index+chunkSize).join(""))
      const slot = state.active === "a" ? "b" : "a"
      state = {...state,[slot]:chunks.length}
      await this.save(prefix,state)
      for (let index=0;index<chunks.length;index++) await this.storage.set(`${prefix}.${slot}.${index}`,chunks[index])
      state = {...state,active:slot,legacy:false}
      await this.save(prefix,state)
    }
    await this.collect(prefix,state)
    await this.clearLegacy(key)
  }
  private async legacyCount(key: string, slot: "A" | "B") {
    const raw = await this.storage.get(`${key}-${slot}-metadata`)
    if (!raw) return 0
    try {
      const count = JSON.parse(raw).totalChunks
      if (!Number.isInteger(count) || count < 0 || count > maximumChunks) throw unavailable()
      return count as number
    } catch {throw unavailable()}
  }
  private async readLegacy(key: string) {
    const latest = await this.storage.get(`${key}-latest`)
    if (latest !== null && latest !== "A" && latest !== "B") throw unavailable()
    for (const slot of (latest === "B" ? ["B","A"] : ["A","B"]) as ("A" | "B")[]) {
      if (await this.storage.get(`${key}-${slot}-complete`) !== "true") continue
      const count = await this.legacyCount(key,slot)
      let value = "", valid = true
      for (let index=0;index<count;index++) {
        const chunk = await this.storage.get(`${key}-${slot}-chunk-${index}`)
        if (chunk === null) {valid=false;break}
        value += chunk
        if (value.length > maximumChunks * chunkSize) throw unavailable()
      }
      if (valid && count) return value
    }
    return null
  }
  async clearLegacy(key: string) {
    this.prefix(key)
    // The new manifest remains even for an empty value: a failed legacy cleanup
    // must never make an old SDK snapshot readable again.
    for (const slot of ["A","B"] as const) {
      const count = await this.legacyCount(key,slot)
      await this.storage.remove(`${key}-${slot}-complete`)
      for (let index=0;index<count;index++) await this.storage.remove(`${key}-${slot}-chunk-${index}`)
      await this.storage.remove(`${key}-${slot}-metadata`)
    }
    await this.storage.remove(`${key}-latest`)
  }
}
