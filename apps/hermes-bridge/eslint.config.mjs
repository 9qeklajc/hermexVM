import { config } from "@repo/eslint-config/base";

export default [
  // The fake gateway fixture is a plain Node script outside the TS project.
  { ignores: ["test-fixtures/**"] },
  ...config,
];
