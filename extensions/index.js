// The entry pi loads from the published package. It sits here, not in dist/,
// because pi lists an extension at `extensions/index.js` by the package's name
// alone, and one anywhere else by the name and its path. From a clone, pi loads
// extension/index.ts instead (`pi -e extension`).
export { default } from "../dist/extension/index.js";
