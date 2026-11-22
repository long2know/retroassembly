import { syntheticFilterRomCount } from './synthetic-platform-filter.ts'

export const syntheticBatteryRomName = 'Battery Colors.nes'
export const syntheticNesRomCount = 3 + syntheticFilterRomCount

export function createSyntheticNesRom() {
  const header = Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  const prg = Buffer.alloc(16 * 1024, 0xea)
  // Original NROM program: cycle the universal background palette once per vblank.
  const program = [
    0x78, 0xd8, 0xa2, 0xff, 0x9a, 0xe8, 0x8e, 0x00, 0x20, 0x8e, 0x01, 0x20, 0x86, 0x00, 0x2c, 0x02, 0x20, 0x10, 0xfb,
    0xa9, 0x3f, 0x8d, 0x06, 0x20, 0xa9, 0x00, 0x8d, 0x06, 0x20, 0xa5, 0x00, 0x29, 0x3f, 0x8d, 0x07, 0x20, 0xe6, 0x00,
    0xa9, 0x00, 0x8d, 0x06, 0x20, 0x8d, 0x06, 0x20, 0x2c, 0x02, 0x20, 0x30, 0xfb, 0x4c, 0x0e, 0x80,
  ]
  prg.set(program)
  for (const vector of [0x3f_fa, 0x3f_fc, 0x3f_fe]) {
    prg.writeUInt16LE(0x80_00, vector)
  }
  return Buffer.concat([header, prg, Buffer.alloc(8 * 1024)])
}

export function createSyntheticBatteryNesRom() {
  // Original MMC1 cartridge with CHR RAM and 8 KiB of battery-backed PRG RAM.
  const header = Buffer.from([0x4e, 0x45, 0x53, 0x1a, 2, 0, 0x12, 0, 1, 0, 0, 0, 0, 0, 0, 0])
  const prg = Buffer.alloc(32 * 1024, 0xea)
  const program: number[] = []
  const labels = new Map<string, number>()
  const branches = new Map<number, string>()
  function emit(...bytes: number[]) {
    program.push(...bytes)
  }
  function label(name: string) {
    labels.set(name, program.length)
  }
  function address(name: string) {
    const offset = labels.get(name)
    if (offset === undefined) {
      throw new Error(`Missing cartridge program label: ${name}`)
    }
    return offset
  }
  function branch(opcode: number, target: string) {
    branches.set(program.length + 1, target)
    emit(opcode, 0)
  }
  emit(0x78, 0xd8, 0xa2, 0xff, 0x9a, 0xe8) // SEI; CLD; initialize stack and clear X
  emit(0x8e, 0x00, 0x20, 0x8e, 0x01, 0x20) // Disable PPU interrupts and rendering
  emit(0x86, 0x00, 0x86, 0x01, 0x86, 0x02) // Previous A, volatile display flag, previous B
  label('warmup')
  emit(0x2c, 0x02, 0x20) // BIT $2002
  branch(0x10, 'warmup')
  label('frame')
  emit(0x2c, 0x02, 0x20)
  branch(0x10, 'frame')
  emit(0xa9, 1, 0x8d, 0x16, 0x40, 0x8e, 0x16, 0x40) // Strobe controller
  emit(0xad, 0x16, 0x40, 0x29, 1, 0xa8, 0x45, 0x00, 0x84, 0x00) // Read A and detect change
  branch(0xf0, 'buttonB')
  emit(0x98)
  branch(0xf0, 'buttonB')
  emit(0xa9, 0xa5, 0x8d, 0x00, 0x60) // Game's in-game save: write marker to PRG RAM
  label('buttonB')
  emit(0xad, 0x16, 0x40, 0x29, 1, 0xa8, 0x45, 0x02, 0x84, 0x02)
  branch(0xf0, 'draw')
  emit(0x98)
  branch(0xf0, 'draw')
  emit(0xa5, 0x01, 0x49, 1, 0x85, 0x01) // B toggles a volatile flag, only saved in snapshots
  label('draw')
  emit(0xa9, 0x3f, 0x8d, 0x06, 0x20, 0x8e, 0x06, 0x20) // Set PPU palette address
  emit(0xa5, 0x01)
  branch(0xf0, 'readSave')
  emit(0xa9, 0x12) // Blue when the volatile flag is set
  branch(0xd0, 'color')
  label('readSave')
  emit(0xad, 0x00, 0x60, 0xc9, 0xa5) // Red when blank, green when saved
  branch(0xf0, 'saved')
  emit(0xa9, 0x16)
  branch(0xd0, 'color')
  label('saved')
  emit(0xa9, 0x2a)
  label('color')
  emit(0x8d, 0x07, 0x20, 0x8e, 0x06, 0x20, 0x8e, 0x06, 0x20)
  emit(0x4c, address('frame'), 0xc0) // JMP frame (first page)
  for (const [operand, target] of branches) {
    program[operand] = (address(target) - operand - 1 + 256) % 256
  }
  prg.set(program, 0x40_00)
  for (const vector of [0x7f_fa, 0x7f_fc, 0x7f_fe]) {
    prg.writeUInt16LE(0xc0_00, vector)
  }
  return Buffer.concat([header, prg])
}
