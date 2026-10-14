#!/usr/bin/env bash
# Builds the LGPL ffmpeg that OpenReader ships for one target: a self-contained
# executable with only the audio components OpenReader uses, statically linked
# with LAME for MP3 encoding. The ffmpeg workflow runs it once per target and
# publishes the results; see packaging/ffmpeg/README.md.
#
# Usage: packaging/ffmpeg/build.sh <target> <work-dir>
#   darwin-universal         on macOS with Xcode command line tools, nasm, gnupg
#   linux-x64, linux-arm64   on Alpine Linux of that architecture (static musl)
#   win32-x64, win32-arm64   on Linux, cross-compiled with a pinned llvm-mingw
#   sources                  the exact sources and build files, which are the
#                            LGPL "corresponding source" published beside them
# Output: <work-dir>/out/
set -euo pipefail

TARGET="${1:?Usage: build.sh <target> <work-dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mkdir -p "${2:?Usage: build.sh <target> <work-dir>}" && cd "$2" && pwd)"
FFMPEG_VERSION="$(node -p "require('$HERE/manifest.json').ffmpegVersion")"
# FFmpeg release signing key <ffmpeg-devel@ffmpeg.org>.
FFMPEG_KEY_FINGERPRINT="FCF986EA15E6E293A5644F10B4322F04D67658D8"
LAME_VERSION="3.100"
LAME_SHA256="ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"
LLVM_MINGW_VERSION="20261006"
LLVM_MINGW_SHA256_x86_64="5f9c6ed95b2d4bdb2869a488c5fd5857fbdabcf288a0aa3eb1da43f6a08d8ab4"
LLVM_MINGW_SHA256_aarch64="e77c4acfa44184f6b0c52b814d724ad63b2ecebb3c3f6f842c0846e717cbd23c"
MACOS_MIN="12.0"

NAME="ffmpeg-${FFMPEG_VERSION}-lgpl-${TARGET}"
SRC="$WORK/src"
BUILD="$WORK/build/$TARGET"
OUT="$WORK/out"
JOBS="$(getconf _NPROCESSORS_ONLN)"
EXE=""
case "$TARGET" in win32-*) EXE=".exe" ;; esac
rm -rf "$BUILD"
mkdir -p "$SRC" "$BUILD" "$OUT"

# LGPL v3, no GPL or nonfree code, nothing autodetected from the build machine.
# The components are exactly what smoke-test.mjs exercises.
FFMPEG_OPTIONS=(
  --enable-version3 --disable-autodetect --disable-everything
  --disable-doc --disable-debug --disable-ffplay --disable-ffprobe --disable-network
  --enable-static --disable-shared
  --enable-libmp3lame
  --enable-protocol=file,pipe
  --enable-indev=lavfi
  --enable-demuxer=aac,flac,matroska,mov,mp3,ogg,wav,ffmetadata
  --enable-decoder=aac,aac_fixed,flac,mp3,mp3float,opus,vorbis,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8,pcm_alaw,pcm_mulaw
  --enable-encoder=libmp3lame,aac,pcm_s16le
  --enable-muxer=mp3,mp4,ipod,wav,pcm_s16le,ffmetadata
  --enable-parser=aac,flac,mpegaudio,opus,vorbis
  --enable-bsf=aac_adtstoasc
  --enable-filter=abuffer,abuffersink,aformat,anull,anullsrc,aresample,atempo,sine
)

sha256_check() { # <sha256> <file>
  if command -v sha256sum >/dev/null; then echo "$1  $2" | sha256sum -c -; else echo "$1  $2" | shasum -a 256 -c -; fi
}

fetch_sources() {
  cd "$SRC"
  [ -f "lame-${LAME_VERSION}.tar.gz" ] || curl -fsSL -o "lame-${LAME_VERSION}.tar.gz" \
    "https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"
  sha256_check "$LAME_SHA256" "lame-${LAME_VERSION}.tar.gz"

  [ -f "ffmpeg-${FFMPEG_VERSION}.tar.xz" ] || curl -fsSL -o "ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
  curl -fsSL -o "ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz.asc"
  curl -fsSL -o ffmpeg-devel.asc "https://ffmpeg.org/ffmpeg-devel.asc"
  export GNUPGHOME="$WORK/gnupg"
  rm -rf "$GNUPGHOME" && mkdir -m 700 "$GNUPGHOME"
  gpg --batch --quiet --import ffmpeg-devel.asc
  gpg --batch --status-fd 1 --verify "ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" "ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    | grep -q "VALIDSIG ${FFMPEG_KEY_FINGERPRINT} " \
    || { echo "ffmpeg-${FFMPEG_VERSION}.tar.xz is not signed by ${FFMPEG_KEY_FINGERPRINT}" >&2; exit 1; }
  cd - >/dev/null
}

# build_lame <dir> <cc> <flags> [configure options...]: static libmp3lame in <dir>/prefix.
build_lame() {
  local dir="$1" cc="$2" flags="$3"
  shift 3
  tar -xzf "$SRC/lame-${LAME_VERSION}.tar.gz" -C "$dir"
  (
    cd "$dir/lame-${LAME_VERSION}"
    CC="$cc" CFLAGS="$flags -O2" LDFLAGS="$flags" ./configure --prefix="$dir/prefix" \
      --disable-shared --enable-static --disable-frontend --disable-decoder "$@"
    make -j"$JOBS" && make install
  )
}

# build_ffmpeg <dir> <cflags> <ldflags> [configure options...]: the stripped
# executable lands in <dir>/ffmpeg-<version>/.
build_ffmpeg() {
  local dir="$1" cflags="$2" ldflags="$3"
  shift 3
  tar -xJf "$SRC/ffmpeg-${FFMPEG_VERSION}.tar.xz" -C "$dir"
  (
    cd "$dir/ffmpeg-${FFMPEG_VERSION}"
    ./configure --prefix="$dir/prefix" \
      --extra-cflags="$cflags -I$dir/prefix/include" --extra-ldflags="$ldflags -L$dir/prefix/lib" \
      "${FFMPEG_OPTIONS[@]}" "$@"
    make -j"$JOBS" "ffmpeg$EXE"
  )
}

# package <executable> <source-dir>: <NAME>.tar.gz holding bin/, LICENSE.txt and BUILD.txt.
package() {
  local exe="$1" src_dir="$2" stage="$BUILD/$NAME"
  mkdir -p "$stage/bin"
  cp "$exe" "$stage/bin/"
  local ffmpeg_src="$src_dir/ffmpeg-${FFMPEG_VERSION}" lame_src="$src_dir/lame-${LAME_VERSION}"
  {
    echo "FFmpeg ${FFMPEG_VERSION} is licensed under the GNU Lesser General Public License version 3."
    echo "It is linked statically with LAME ${LAME_VERSION} (GNU Library General Public License version 2)."
    echo "The exact sources and build script are published with this archive:"
    echo "https://github.com/richardr1126/openreader/releases/tag/$(node -p "require('$HERE/manifest.json').release")"
    printf '\n==== FFmpeg: COPYING.LGPLv3 ====\n\n'; cat "$ffmpeg_src/COPYING.LGPLv3"
    printf '\n==== FFmpeg: COPYING.GPLv3 (incorporated by the LGPL v3) ====\n\n'; cat "$ffmpeg_src/COPYING.GPLv3"
    printf '\n==== LAME: COPYING ====\n\n'; cat "$lame_src/COPYING"
  } > "$stage/LICENSE.txt"
  {
    echo "FFmpeg ${FFMPEG_VERSION} + LAME ${LAME_VERSION} for ${TARGET}, built by packaging/ffmpeg/build.sh"
    echo
    sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' "$ffmpeg_src/config.h"
  } > "$stage/BUILD.txt"
  tar -C "$BUILD" -czf "$OUT/$NAME.tar.gz" "$NAME"
  echo "[ffmpeg] $OUT/$NAME.tar.gz"
}

fail() { echo "[ffmpeg] $*" >&2; exit 1; }

case "$TARGET" in
  darwin-universal)
    [ "$(uname -s)" = Darwin ] || fail "$TARGET builds on macOS"
    fetch_sources
    for arch in arm64 x86_64; do
      dir="$BUILD/$arch"; mkdir -p "$dir"
      flags="-arch $arch -mmacosx-version-min=$MACOS_MIN"
      triple="$([ "$arch" = arm64 ] && echo aarch64-apple-darwin || echo x86_64-apple-darwin)"
      cross="$([ "$arch" = "$(uname -m)" ] && echo "" || echo "--enable-cross-compile")"
      build_lame "$dir" clang "$flags" --host="$triple"
      build_ffmpeg "$dir" "$flags" "$flags" --cc=clang --arch="$arch" --target-os=darwin $cross
    done
    exe="$BUILD/ffmpeg"
    lipo -create "$BUILD/arm64/ffmpeg-${FFMPEG_VERSION}/ffmpeg" "$BUILD/x86_64/ffmpeg-${FFMPEG_VERSION}/ffmpeg" -output "$exe"
    lipo "$exe" -verify_arch arm64 x86_64
    if otool -L "$exe" | tail -n +2 | grep -v -E '/usr/lib/|/System/Library/'; then
      fail "ffmpeg links a library outside the macOS system"
    fi
    node "$HERE/smoke-test.mjs" "$exe"
    package "$exe" "$BUILD/arm64"
    ;;

  linux-x64 | linux-arm64)
    arch="$([ "$TARGET" = linux-x64 ] && echo x86_64 || echo aarch64)"
    [ -f /etc/alpine-release ] && [ "$(uname -m)" = "$arch" ] || fail "$TARGET builds on $arch Alpine Linux"
    fetch_sources
    build_lame "$BUILD" gcc ""
    build_ffmpeg "$BUILD" "" "-static"
    exe="$BUILD/ffmpeg-${FFMPEG_VERSION}/ffmpeg"
    if readelf -d "$exe" | grep -q NEEDED; then fail "ffmpeg is not fully static"; fi
    node "$HERE/smoke-test.mjs" "$exe"
    package "$exe" "$BUILD"
    ;;

  win32-x64 | win32-arm64)
    arch="$([ "$TARGET" = win32-x64 ] && echo x86_64 || echo aarch64)"
    triple="${arch}-w64-mingw32"
    host="$(uname -m)"
    [ "$(uname -s)" = Linux ] || fail "$TARGET cross-compiles on Linux"
    toolchain="llvm-mingw-${LLVM_MINGW_VERSION}-ucrt-ubuntu-22.04-${host}"
    sha_var="LLVM_MINGW_SHA256_${host}"
    [ -n "${!sha_var:-}" ] || fail "no llvm-mingw pinned for a ${host} build machine"
    if [ ! -x "$WORK/$toolchain/bin/clang" ]; then
      curl -fsSL -o "$WORK/$toolchain.tar.xz" \
        "https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_MINGW_VERSION}/${toolchain}.tar.xz"
      sha256_check "${!sha_var}" "$WORK/$toolchain.tar.xz"
      tar -xJf "$WORK/$toolchain.tar.xz" -C "$WORK"
      rm "$WORK/$toolchain.tar.xz"
    fi
    export PATH="$WORK/$toolchain/bin:$PATH"
    fetch_sources
    build_lame "$BUILD" "$triple-clang" "" --host="$triple"
    build_ffmpeg "$BUILD" "" "-static" --cc="$triple-clang" --cross-prefix="$triple-" \
      --arch="$arch" --target-os=mingw32 --enable-cross-compile
    exe="$BUILD/ffmpeg-${FFMPEG_VERSION}/ffmpeg$EXE"
    # Only DLLs that ship with Windows 10 and later.
    dlls="$(llvm-objdump -p "$exe" | sed -n 's/^ *DLL Name: //p')"
    echo "$dlls"
    if echo "$dlls" | grep -v -i -E '^(api-ms-win-[a-z0-9-]+|kernel32|advapi32|bcrypt|user32|ole32|shell32|ws2_32|msvcrt|ucrtbase)\.dll$'; then
      fail "ffmpeg.exe links a DLL that is not part of Windows"
    fi
    # The ffmpeg workflow runs the smoke test on Windows.
    package "$exe" "$BUILD"
    ;;

  sources)
    fetch_sources
    cp "$SRC/ffmpeg-${FFMPEG_VERSION}.tar.xz" "$SRC/ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" \
      "$SRC/lame-${LAME_VERSION}.tar.gz" "$HERE/build.sh" "$HERE/smoke-test.mjs" "$OUT/"
    ;;

  *) fail "unknown target: $TARGET" ;;
esac
