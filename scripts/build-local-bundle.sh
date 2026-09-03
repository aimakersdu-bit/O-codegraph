#!/usr/bin/env bash
#
# Build a CodeGraph bundle directory using the local Node.js installation as
# the bundled runtime source. This script does not download Node and does not
# create a tar.gz archive.
#
# The generated launchers run the bundled node by relative path, so the target
# machine does not need a system Node.js installation.
#
# Usage:
#   scripts/build-local-bundle.sh
#
# Output:
#   release/codegraph/
set -euo pipefail

# The local bundle must not perform npm update checks or emit upgrade notices.
export NPM_CONFIG_UPDATE_NOTIFIER=false

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! command -v node >/dev/null 2>&1; then
  echo "[local-bundle] error: node not found in PATH" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
if command -v realpath >/dev/null 2>&1; then
  NODE_BIN="$(realpath "$NODE_BIN")"
fi
if [ ! -f "$NODE_BIN" ] && [ -f "${NODE_BIN}.exe" ]; then
  NODE_BIN="${NODE_BIN}.exe"
fi
NODE_VERSION="$("$NODE_BIN" -v)"

case "$(uname -s)" in
  Darwin) OSFAM="darwin" ;;
  Linux) OSFAM="linux" ;;
  MINGW* | MSYS* | CYGWIN*) OSFAM="win32" ;;
  *)
    echo "[local-bundle] error: unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH="x64" ;;
  arm64 | aarch64) ARCH="arm64" ;;
  *)
    echo "[local-bundle] error: unsupported arch: $(uname -m)" >&2
    exit 1
    ;;
esac

TARGET="${OSFAM}-${ARCH}"
STAGE="$WORK/codegraph"
BUNDLE_DIR="$OUT/codegraph"

echo "[local-bundle] target=${TARGET} local-node=${NODE_VERSION} (${NODE_BIN})"

echo "[local-bundle] building app and packages"
( cd "$ROOT" && npm run build >/dev/null )
( cd "$ROOT" && npm run build -w packages/shared >/dev/null )
( cd "$ROOT" && npm run build -w packages/ingestion-server >/dev/null )
( cd "$ROOT" && npm run build -w packages/mcp-server >/dev/null )
( cd "$ROOT" && npm run build -w packages/ci-cli >/dev/null )

echo "[local-bundle] staging files"
mkdir -p "$STAGE/lib" "$STAGE/bin"
cp -R "$ROOT/dist" "$STAGE/lib/dist"

mkdir -p "$STAGE/lib/packages/shared"
mkdir -p "$STAGE/lib/packages/ingestion-server"
mkdir -p "$STAGE/lib/packages/mcp-server"
mkdir -p "$STAGE/lib/packages/ci-cli"

cp "$ROOT/packages/shared/package.json" "$STAGE/lib/packages/shared/"
cp -R "$ROOT/packages/shared/dist" "$STAGE/lib/packages/shared/dist"

cp "$ROOT/packages/ingestion-server/package.json" "$STAGE/lib/packages/ingestion-server/"
cp -R "$ROOT/packages/ingestion-server/dist" "$STAGE/lib/packages/ingestion-server/dist"

cp "$ROOT/packages/mcp-server/package.json" "$STAGE/lib/packages/mcp-server/"
cp -R "$ROOT/packages/mcp-server/dist" "$STAGE/lib/packages/mcp-server/dist"

cp "$ROOT/packages/ci-cli/package.json" "$STAGE/lib/packages/ci-cli/"
cp -R "$ROOT/packages/ci-cli/dist" "$STAGE/lib/packages/ci-cli/dist"

cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/lib/"

if [ ! -d "$ROOT/node_modules" ]; then
  echo "[local-bundle] error: node_modules not found. Run npm install first." >&2
  exit 1
fi

echo "[local-bundle] copying existing node_modules"
mkdir -p "$STAGE/lib/node_modules"
for dependency in "$ROOT/node_modules"/* "$ROOT/node_modules"/@*/*; do
  [ -e "$dependency" ] || [ -L "$dependency" ] || continue

  relative="${dependency#"$ROOT/node_modules"/}"
  case "$relative" in
    @codegraph | @codegraph/* | @colbymchenry | @colbymchenry/*)
      continue
      ;;
  esac

  destination="$STAGE/lib/node_modules/$relative"
  mkdir -p "$(dirname "$destination")"
  cp -R -L "$dependency" "$destination"
done

if [ "$OSFAM" != "win32" ]; then
  echo "[local-bundle] pruning dev dependencies in staged copy"
  ( cd "$STAGE/lib" && npm prune --omit=dev --ignore-scripts >/dev/null 2>&1 )
  rm -f "$STAGE/lib/package-lock.json"
else
  echo "[local-bundle] skipping npm prune on Windows to avoid workspace symlink rewrites"
  rm -f "$STAGE/lib/package-lock.json"
fi

echo "[local-bundle] materializing workspace packages in node_modules"
mkdir -p "$STAGE/lib/node_modules/@colbymchenry"
mkdir -p "$STAGE/lib/node_modules/@codegraph"

rm -rf "$STAGE/lib/node_modules/@colbymchenry/codegraph"
mkdir -p "$STAGE/lib/node_modules/@colbymchenry/codegraph"
cp "$ROOT/package.json" "$STAGE/lib/node_modules/@colbymchenry/codegraph/"
cp -R "$ROOT/dist" "$STAGE/lib/node_modules/@colbymchenry/codegraph/dist"

for pkg in shared ingestion-server mcp-server ci-cli; do
  rm -rf "$STAGE/lib/node_modules/@codegraph/$pkg"
  mkdir -p "$STAGE/lib/node_modules/@codegraph/$pkg"
  cp "$ROOT/packages/$pkg/package.json" "$STAGE/lib/node_modules/@codegraph/$pkg/"
  cp -R "$ROOT/packages/$pkg/dist" "$STAGE/lib/node_modules/@codegraph/$pkg/dist"
done

echo "[local-bundle] copying local node runtime"
if [ "$OSFAM" = "win32" ]; then
  cp "$NODE_BIN" "$STAGE/node.exe"

  NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
  while IFS= read -r -d '' dll; do
    echo "[local-bundle] copying $(basename "$dll")"
    cp "$dll" "$STAGE/$(basename "$dll")"
  done < <(find "$NODE_DIR" -maxdepth 1 -type f -iname '*.dll' -print0)
else
  cp "$NODE_BIN" "$STAGE/node"
  chmod +x "$STAGE/node"
fi

if [ "$OSFAM" = "darwin" ]; then
  resolve_macos_dependency() {
    local dep="$1"
    local name=""

    case "$dep" in
      /usr/lib/* | /System/*)
        return 0
        ;;
      @rpath/*)
        name="${dep#@rpath/}"
        for candidate in \
          "$(dirname "$NODE_BIN")/../lib/$name" \
          "$(dirname "$NODE_BIN")/../../lib/$name" \
          "/opt/homebrew/lib/$name" \
          "/usr/local/lib/$name" \
          /opt/homebrew/opt/*/lib/"$name" \
          /usr/local/opt/*/lib/"$name"; do
          if [ -f "$candidate" ]; then
            echo "$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
            return 0
          fi
        done
        ;;
      @loader_path/* | @executable_path/*)
        name="$(basename "$dep")"
        for candidate in \
          "/opt/homebrew/lib/$name" \
          "/usr/local/lib/$name" \
          /opt/homebrew/opt/*/lib/"$name" \
          /usr/local/opt/*/lib/"$name"; do
          if [ -f "$candidate" ]; then
            echo "$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
            return 0
          fi
        done
        ;;
      /*)
        if [ -f "$dep" ]; then
          echo "$dep"
          return 0
        fi
        ;;
      *)
        return 0
        ;;
    esac

    return 1
  }

  copy_macos_dependency() {
    local dep="$1"
    local source=""
    local name=""

    case "$dep" in
      /usr/lib/* | /System/*)
        return 0
        ;;
      @rpath/* | @loader_path/* | @executable_path/* | /*)
        name="$(basename "$dep")"
        ;;
      *)
        return 0
        ;;
    esac

    if [ -f "$STAGE/$name" ]; then
      return 0
    fi

    source="$(resolve_macos_dependency "$dep" || true)"

    if [ -z "$source" ]; then
      echo "[local-bundle] error: required macOS dependency not found: $dep" >&2
      exit 1
    fi

    echo "[local-bundle] copying $name"
    cp "$source" "$STAGE/$name"
    chmod +w "$STAGE/$name" 2>/dev/null || true
  }

  list_macos_dependencies() {
    otool -L "$1" \
      | sed -n -E 's|^[[:space:]]+([^[:space:]]+)[[:space:]].*|\1|p'
  }

  for _ in 1 2 3; do
    while IFS= read -r dep; do
      copy_macos_dependency "$dep"
    done < <(list_macos_dependencies "$NODE_BIN")

    for dylib in "$STAGE"/*.dylib; do
      [ -f "$dylib" ] || continue
      while IFS= read -r dep; do
        copy_macos_dependency "$dep"
      done < <(list_macos_dependencies "$dylib")
    done
  done

  # Keep the copied Node binary untouched. The generated launchers point the
  # dynamic linker at the bundle root so Homebrew dylibs copied above can be
  # found on machines without a system Node.js installation.
fi

generate_launcher() {
  local name="$1"
  local entry="$2"
  local extra_args="${3:-}"

  if [ "$OSFAM" = "win32" ]; then
    local entry_win
    entry_win="$(printf '%s' "$entry" | sed 's|/|\\|g')"
    printf '@"%%~dp0..\\node.exe" --experimental-sqlite %s "%%~dp0..\\%s" %%*\r\n' \
      "$extra_args" "$entry_win" > "$STAGE/bin/${name}.cmd"
    return 0
  fi

  cat > "$STAGE/bin/${name}" <<LAUNCH
#!/bin/sh
# Resolve symlinks so we find the real bundle dir, not the symlink's location.
SELF="\$0"
while [ -L "\$SELF" ]; do
  target="\$(readlink "\$SELF")"
  case "\$target" in
    /*) SELF="\$target" ;;
    *) SELF="\$(dirname "\$SELF")/\$target" ;;
  esac
done
DIR="\$(cd "\$(dirname "\$SELF")/.." && pwd)"
if [ "\$(uname -s)" = "Darwin" ]; then
  export DYLD_LIBRARY_PATH="\$DIR\${DYLD_LIBRARY_PATH:+:\$DYLD_LIBRARY_PATH}"
else
  export LD_LIBRARY_PATH="\$DIR\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
fi
exec "\$DIR/node" ${extra_args} "\$DIR/${entry}" "\$@"
LAUNCH
  chmod +x "$STAGE/bin/${name}"
}

generate_launcher "codegraph" "lib/dist/bin/codegraph.js" "--liftoff-only"
generate_launcher "codegraph-ci" "lib/packages/ci-cli/dist/index.js"
generate_launcher "codegraph-ingestion" "lib/packages/ingestion-server/dist/index.js"
generate_launcher "codegraph-mcp" "lib/packages/mcp-server/dist/index.js"

echo "[local-bundle] verifying bundled runtime and module resolution"
if [ "$OSFAM" = "win32" ]; then
  BUNDLED_NODE="$STAGE/node.exe"
else
  BUNDLED_NODE="$STAGE/node"
fi

BUNDLE_ROOT="$STAGE" "$BUNDLED_NODE" --no-warnings --experimental-sqlite <<'VERIFY'
const path = require('path');
const { createRequire } = require('module');

require('node:sqlite');

const bundleRoot = process.env.BUNDLE_ROOT;
const requireFromCi = createRequire(path.join(bundleRoot, 'lib', 'packages', 'ci-cli', 'dist', 'index.js'));
const modules = [
  '@colbymchenry/codegraph',
  '@colbymchenry/codegraph/dist/search/query-parser',
  '@colbymchenry/codegraph/dist/search/query-utils',
  '@codegraph/shared/dist/index.js',
  '@codegraph/shared/dist/queries.js',
  path.join(bundleRoot, 'lib', 'packages', 'ci-cli', 'dist', 'extractor.js'),
  path.join(bundleRoot, 'lib', 'packages', 'ci-cli', 'dist', 'sqlite-exporter.js'),
];

for (const mod of modules) {
  requireFromCi.resolve(mod);
}
VERIFY

mkdir -p "$OUT"
rm -rf "$BUNDLE_DIR"
mv "$STAGE" "$BUNDLE_DIR"
echo "[local-bundle] wrote ${BUNDLE_DIR}"
