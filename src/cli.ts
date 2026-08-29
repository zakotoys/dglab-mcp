export interface CliOptions {
  presetSource?: string;
}

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export function parseCliArgs(args: string[]): CliOptions {
  let presetSource: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument !== "-p" && argument !== "--preset") {
      throw new CliArgumentError(`unknown argument "${argument}"`);
    }
    if (presetSource !== undefined) {
      throw new CliArgumentError("--preset may only be specified once");
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new CliArgumentError(`${argument} requires a source`);
    }
    index += 1;

    presetSource = value;
  }

  return { presetSource };
}
