export interface CliOptions {
  presetUrl?: URL;
}

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export function parseCliArgs(args: string[]): CliOptions {
  let presetUrl: URL | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument !== "-p" && argument !== "--preset") {
      throw new CliArgumentError(`unknown argument "${argument}"`);
    }
    if (presetUrl !== undefined) {
      throw new CliArgumentError("--preset may only be specified once");
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new CliArgumentError(`${argument} requires an HTTP(S) URL`);
    }
    index += 1;

    try {
      presetUrl = new URL(value);
    } catch {
      throw new CliArgumentError(`${argument} must be a valid URL, got "${value}"`);
    }
    if (presetUrl.protocol !== "http:" && presetUrl.protocol !== "https:") {
      throw new CliArgumentError(
        `${argument} must use the http: or https: scheme, got "${presetUrl.protocol}"`,
      );
    }
  }

  return { presetUrl };
}
