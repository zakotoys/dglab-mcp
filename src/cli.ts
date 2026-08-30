export interface CliOptions {
  presetSources: string[];
  skipInvalidPresets?: boolean;
}

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export function parseCliArgs(args: string[]): CliOptions {
  const presetSources: string[] = [];
  let skipInvalidPresets = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--skip-invalid-presets") {
      skipInvalidPresets = true;
      continue;
    }
    if (argument !== "-p" && argument !== "--preset") {
      throw new CliArgumentError(`unknown argument "${argument}"`);
    }

    let valuesAdded = 0;
    while (index + 1 < args.length && !args[index + 1]!.startsWith("-")) {
      presetSources.push(args[index + 1]!);
      index += 1;
      valuesAdded += 1;
    }
    if (valuesAdded === 0) {
      throw new CliArgumentError(`${argument} requires a source`);
    }
  }

  return skipInvalidPresets ? { presetSources, skipInvalidPresets: true } : { presetSources };
}
