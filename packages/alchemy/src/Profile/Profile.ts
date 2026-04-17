import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import os from "node:os";
import path from "pathe";
import type { AuthProvider } from "./AuthProvider.ts";

export const rootDir = path.join(os.homedir(), ".alchemy");
export const configFilePath = path.join(rootDir, "profiles.json");

export const CONFIG_VERSION = 0;

export class AlchemyConfig extends Context.Service<
  AlchemyConfig,
  {
    version: typeof CONFIG_VERSION;
    profiles: {
      [profileName: string]: AlchemyProfile;
    };
  }
>()("Alchemy::Profiles") {}

export interface AlchemyProfile {
  [providerName: string]: {
    /**
     * The method used to login to the provider. Different providers may use different methods, but common ones are:
     * - oauth: OAuth authentication
     * - api-key: API key authentication
     * - username-password: Username and password authentication
     * - token: Token authentication
     * - certificate: Certificate authentication
     * - ssh: SSH authentication
     * - other: Other authentication methods
     */
    method: string;
  };
}

const emptyConfig = (): AlchemyConfig["Service"] => ({
  version: CONFIG_VERSION,
  profiles: {},
});

export const readConfig = FileSystem.FileSystem.asEffect().pipe(
  Effect.flatMap((fs) => fs.readFileString(configFilePath)),
  Effect.flatMap((data) =>
    Effect.try({
      try: () => {
        const parsed = JSON.parse(data);
        if (parsed?.version !== CONFIG_VERSION) {
          // TODO(sam): this is destructive, should we maintain a chain of migrations from 0 to current?
          return emptyConfig();
        }
        return parsed as AlchemyConfig["Service"];
      },
      catch: emptyConfig,
    }),
  ),
  Effect.orElseSucceed(emptyConfig),
);

export const writeConfig = (config: AlchemyConfig["Service"]) =>
  FileSystem.FileSystem.asEffect().pipe(
    Effect.tap((fs) =>
      fs.makeDirectory(path.dirname(configFilePath), { recursive: true }),
    ),
    Effect.flatMap((fs) =>
      fs.writeFileString(configFilePath, JSON.stringify(config, null, 2)),
    ),
  );

export const getProfile = (name: string) =>
  readConfig.pipe(Effect.map((config) => config.profiles[name]));

export const setProfile = (name: string, profile: AlchemyProfile) =>
  readConfig.pipe(
    Effect.tap((config) =>
      Effect.sync(() => (config.profiles[name] = profile)),
    ),
    Effect.flatMap(writeConfig),
  );

/**
 * Load the stored config for the given AuthProvider in `profileName`.
 * If absent, run the provider's interactive `configure` step and persist the
 * resulting config under the provider's name.
 */
export const loadOrConfigure = <Config extends { method: string }>(
  auth: AuthProvider<Config>,
  profileName: string,
) =>
  getProfile(profileName).pipe(
    Effect.flatMap((existing) =>
      existing?.[auth.name]
        ? Effect.succeed(existing?.[auth.name])
        : auth
            .configure(profileName)
            .pipe(
              Effect.tap((config) =>
                setProfile(profileName, { ...existing, [auth.name]: config }),
              ),
            ),
    ),
  );
