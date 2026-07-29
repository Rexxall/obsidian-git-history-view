export class App {}

export class FileSystemAdapter {}

export class Notice {
  constructor(
    public readonly message: string,
    public readonly timeout?: number
  ) {}
}

export class TFile {
  constructor(public path = "") {}
}
