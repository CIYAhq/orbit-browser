import { writeFileSync } from 'node:fs'

/**
 * Lightweight performance marks for budgets in PERF.md. Times are ms since
 * process start (performance.timeOrigin), comparable across main marks.
 * Renderer marks arrive via the 'perf.mark' event and are stored with the
 * main-process receive time.
 */
export class Perf {
  readonly marks: { name: string; t: number }[] = []

  mark(name: string): number {
    const t = performance.now()
    this.marks.push({ name, t })
    if (this.marks.length > 5000) this.marks.splice(0, 1000)
    return t
  }

  first(name: string): number | undefined {
    return this.marks.find((m) => m.name === name)?.t
  }

  writeTo(file: string): void {
    try {
      writeFileSync(file, JSON.stringify(this.marks, null, 2))
    } catch (err) {
      console.error('[perf] could not write marks', err)
    }
  }
}
