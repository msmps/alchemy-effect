import {
  Credentials,
  fromAwsCredentialIdentity,
  loadSSOCredentials,
} from "distilled-aws/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { App } from "../App.ts";
import { Profile } from "./Profile.ts";

import "./StageConfig.ts";

export const fromStageConfig = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const app = yield* App;
      if (app.config.aws?.profile) {
        return yield* loadSSOCredentials(app.config.aws.profile);
      } else if (app.config.aws?.credentials) {
        return fromAwsCredentialIdentity(app.config.aws.credentials);
      }
      return yield* Effect.die("No AWS credentials found in stage config");
    }),
  );

export const fromSSO = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profileName = Option.getOrElse(
        yield* Effect.serviceOption(Profile),
        () => "default",
      );
      return yield* loadSSOCredentials(profileName);
    }),
  );
