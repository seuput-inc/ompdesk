#!/bin/bash
# release-assets.sh <mac|win> <tag>: the PUBLISHED bytes of a release, on a throwaway GitHub runner
# (shell-batch-checks.yml only=release-verify: release-assets-mac on macos-15, release-assets-win on windows-latest).
# Downloads the asset with `gh release download` (needs GH_TOKEN) and checks:
#  - the release: published (not a draft or pre-release), exactly the two assets, the tag's version in the
#    `<!-- ompdesk-update {...} -->` metadata the updater reads (src/main/update-release.ts), and GitHub's own size and
#    SHA-256 digest of the asset;
#  - the metadata against the bytes: size and SHA-512 (base64, as electron-updater writes it), the Mac's minimumSystemVersion
#    against src/shared/app-compatibility.json at the tag (release.yml `publish` › Append update metadata);
#  - mac: what release.yml's `mac` job › Verify bundle asserts of the package, on the app copied out of the mounted DMG
#    (`ditto --noextattr --norsrc --noqtn`): `codesign --verify --deep --strict`, the designated requirement
#    `identifier "com.seuput.ompdesk" and certificate root = H"<scripts/mac-signing.json certificateSha1>"`, the leaf
#    certificate (SHA-1 and common name from mac-signing.json), the nested binaries' signatures, LSMinimumSystemVersion
#    against app-compatibility.json (14.x), the Tauri build record (no WebDriver plugin), no CEF.
#    NOT asserted, because nothing in release.yml or AGENTS.md › Signing promises it: Gatekeeper's verdict (`spctl --assess`),
#    notarization and a stapled ticket (`xcrun stapler validate`): OMPdesk's certificate is its own, self-signed, and "nothing is
#    notarized". Their exit codes and output are EVIDENCE lines, so a change of that is seen when it happens.
#  - win: the file is a PE executable. The Authenticode status is read by release-assets-win's PowerShell step (release.yml
#    signs nothing of the setup and checks nothing of it; the signature is evidence, a broken one fails).
# Evidence lines start with "EVIDENCE:". Exit 1 on any failed check.
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
set -u
. "$HERE/check-lib.sh"
PLATFORM=${1:-}; TAG=${2:-}
case "$PLATFORM" in mac) NAME=ompdesk-mac-arm64.dmg ;; win) NAME=ompdesk-windows-setup.exe ;; *) echo "usage: release-assets.sh <mac|win> <tag>"; exit 2 ;; esac
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "the tag must be vX.Y.Z, got: $TAG"; exit 2; }
SLUG=${GH_REPO:-seuput-inc/ompdesk}; VERSION=${TAG#v}
OUT=${RELEASE_VERIFY_OUT:-${RUNNER_TEMP:-/tmp}/release-verify-$PLATFORM}; rm -rf "$OUT"; mkdir -p "$OUT"
FILE=$OUT/$NAME
sha512_b64() { openssl dgst -sha512 -binary "$1" | base64 | tr -d '\n\r'; }
sha256_hex() { openssl dgst -sha256 "$1" | sed 's/^.*= *//'; }
size_of() { wc -c < "$1" | tr -d ' \r\n'; }

step "the release $TAG on GitHub"
RELEASE=$(gh api "repos/$SLUG/releases/tags/$TAG") || { check 1 "release $TAG exists on $SLUG"; exit 1; }
echo "$RELEASE" > "$OUT/release.json"
[ "$(jq -r '.draft or .prerelease' <<<"$RELEASE")" = false ]; check $? "$TAG is published (not a draft, not a pre-release)"
evidence "published $(jq -r .published_at <<<"$RELEASE"); /releases/latest is $(gh api "repos/$SLUG/releases/latest" -q .tag_name 2>&1 | head -1)"
[ "$(jq -r '[.assets[].name] | sort | join(" ")' <<<"$RELEASE")" = "ompdesk-mac-arm64.dmg ompdesk-windows-setup.exe" ]; check $? "the release carries exactly the two assets (got: $(jq -r '[.assets[].name] | sort | join(" ")' <<<"$RELEASE"))"
META=$(jq -r .body <<<"$RELEASE" | sed -n 's/.*<!-- ompdesk-update \(.*\) -->.*/\1/p')
echo "$META" > "$OUT/update-metadata.json"
jq -e . <<<"$META" >/dev/null 2>&1; check $? "the notes carry one parseable ompdesk-update metadata comment"
[ "$(jq -r .version <<<"$META")" = "$VERSION" ]; check $? "the metadata's version is $VERSION"
evidence "metadata: $(jq -c . <<<"$META" | cut -c1-600)"
KEY=mac; [ "$PLATFORM" = win ] && KEY=windows
M_NAME=$(jq -r ".files.$KEY.name" <<<"$META")
M_SIZE=$(jq -r ".files.$KEY.size" <<<"$META")
M_SHA=$(jq -r ".files.$KEY.sha512" <<<"$META")
[ "$M_NAME" = "$NAME" ]; check $? "the metadata names $NAME for $PLATFORM"
G_SIZE=$(jq -r --arg n "$NAME" '.assets[] | select(.name == $n) | .size' <<<"$RELEASE")
G_DIGEST=$(jq -r --arg n "$NAME" '.assets[] | select(.name == $n) | .digest // empty' <<<"$RELEASE")

step "download $NAME"
gh release download "$TAG" --repo "$SLUG" --pattern "$NAME" --dir "$OUT" --clobber; check $? "gh release download $TAG $NAME"
[ -f "$FILE" ] || exit 1
SIZE=$(size_of "$FILE"); SHA=$(sha512_b64 "$FILE"); SHA256=$(sha256_hex "$FILE")
evidence "$NAME: $SIZE bytes, sha512 (base64) $SHA, sha256 $SHA256"
[ "$SIZE" = "$M_SIZE" ]; check $? "size $SIZE equals the metadata's $M_SIZE"
[ "$SIZE" = "$G_SIZE" ]; check $? "size $SIZE equals the size GitHub lists for the asset ($G_SIZE)"
[ "$SHA" = "$M_SHA" ]; check $? "SHA-512 (base64) of the downloaded bytes equals the metadata's"
if [ -n "$G_DIGEST" ]; then [ "$G_DIGEST" = "sha256:$SHA256" ]; check $? "SHA-256 equals GitHub's digest of the asset ($G_DIGEST)"; else evidence "GitHub lists no digest for $NAME"; fi

verify_win() {
  step "the setup is a Windows executable"
  [ "$(head -c 2 "$FILE")" = MZ ]; check $? "$NAME starts with the PE signature MZ"
}

verify_mac() {
  local mnt=$OUT/mnt app=$OUT/OMPdesk.app pin cn requirement leaf minos record host launcher bin nested
  pin=$(jq -er .certificateSha1 "$REPO/scripts/mac-signing.json") || exit 1
  cn=$(jq -er .commonName "$REPO/scripts/mac-signing.json") || exit 1
  step "the minimum system version against the tag's app-compatibility.json"
  local compat; compat=$(gh api -H "Accept: application/vnd.github.raw" "repos/$SLUG/contents/src/shared/app-compatibility.json?ref=$TAG")
  [ "$(jq -r .files.mac.minimumSystemVersion <<<"$META")" = "$(jq -r .minimumDarwin <<<"$compat")" ]; check $? "the metadata's mac minimumSystemVersion is app-compatibility.json's minimumDarwin ($(jq -r .minimumDarwin <<<"$compat"))"
  step "mount the DMG read-only and copy the app out (ditto --noextattr --norsrc --noqtn)"
  mkdir -p "$mnt"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$FILE" >/dev/null; check $? "the DMG mounts read-only"
  evidence "the DMG holds: $(ls -A "$mnt" | tr '\n' ' ')"
  ditto --noextattr --norsrc --noqtn "$mnt/OMPdesk.app" "$app"; check $? "OMPdesk.app copied out of the DMG"
  evidence "the DMG itself: codesign: $(codesign -dv "$FILE" 2>&1 | tr '\n' ' ' | cut -c1-200)"
  hdiutil detach "$mnt" -quiet; check $? "the DMG detaches"
  [ -d "$app" ] || exit 1

  step "signature (release.yml › Verify bundle)"
  codesign --verify --deep --strict --verbose=2 "$app"; check $? "codesign --verify --deep --strict --verbose=2 OMPdesk.app"
  requirement=$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')
  evidence "designated requirement: $requirement"
  [ "$requirement" = "identifier \"com.seuput.ompdesk\" and certificate root = H\"$pin\"" ]; check $? "the designated requirement is identifier com.seuput.ompdesk and certificate root H\"$pin\" (scripts/mac-signing.json)"
  mkdir -p "$OUT/certs"
  (cd "$OUT/certs" && codesign -d --extract-certificates "$app" >/dev/null 2>&1)
  leaf=$(openssl x509 -inform DER -in "$OUT/certs/codesign0" -noout -fingerprint -sha1 2>/dev/null | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')
  evidence "leaf certificate: SHA-1 $leaf, $(openssl x509 -inform DER -in "$OUT/certs/codesign0" -noout -subject -enddate 2>/dev/null | tr '\n' ' '); chain length $(ls "$OUT"/certs | wc -l | tr -d ' ')"
  [ "$leaf" = "$pin" ]; check $? "the leaf certificate's SHA-1 is the pinned $pin"
  openssl x509 -inform DER -in "$OUT/certs/codesign0" -noout -subject 2>/dev/null | grep -q "CN *= *$cn"; check $? "its common name is \"$cn\" (mac-signing.json)"
  evidence "codesign -dvv: $(codesign -dvv "$app" 2>&1 | grep -E 'Identifier|Format|flags|Authority|TeamIdentifier|Timestamp|Signature' | tr '\n' '|' | cut -c1-500)"
  codesign --verify --strict -R "=identifier \"ai-memory\" and certificate root = H\"$pin\"" "$app/Contents/Resources/ai-memory-bin/ai-memory"; check $? "ai-memory carries its own requirement (identifier ai-memory, the pinned certificate root)"
  for nested in Contents/Resources/ai-memory-bin/ai-memory Contents/Resources/agent-desktop-bin/agent-desktop Contents/Resources/agent-desktop-bin/agent-desktop-macos-helper Contents/Resources/ompdesk-bin/ompdesk Contents/Resources/ompdesk-bin/ompdesk-core Contents/Resources/node/node; do
    codesign --verify --strict --verbose=2 "$app/$nested"; check $? "codesign --verify --strict: $nested"
  done

  step "Gatekeeper and notarization: EVIDENCE, not asserted (self-signed certificate, nothing is notarized)"
  evidence "spctl --status: $(spctl --status 2>&1 | tr '\n' ' ')"
  local out rc
  out=$(spctl --assess --type execute -vv "$app" 2>&1); rc=$?
  evidence "spctl --assess --type execute -vv OMPdesk.app: exit $rc: $(echo "$out" | tr '\n' ' ')"
  out=$(spctl --assess --type open --context context:primary-signature -vv "$FILE" 2>&1); rc=$?
  evidence "spctl --assess --type open (the DMG): exit $rc: $(echo "$out" | tr '\n' ' ')"
  out=$(xcrun stapler validate "$app" 2>&1); rc=$?
  evidence "xcrun stapler validate OMPdesk.app: exit $rc: $(echo "$out" | tr '\n' ' ')"
  out=$(xcrun stapler validate "$FILE" 2>&1); rc=$?
  evidence "xcrun stapler validate (the DMG): exit $rc: $(echo "$out" | tr '\n' ' ')"
  evidence "quarantine attribute on the copied app: $(xattr -l "$app" 2>&1 | grep -c com.apple.quarantine) (ditto --noqtn; a download in a browser would add one)"

  step "the package (release.yml › Verify bundle)"
  [ "$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")" = "$VERSION" ]; check $? "CFBundleShortVersionString is $VERSION"
  [ "$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")" = com.seuput.ompdesk ]; check $? "CFBundleIdentifier is com.seuput.ompdesk"
  [ "$(plutil -extract CFBundleExecutable raw -o - "$app/Contents/Info.plist")" = OMPdesk ]; check $? "CFBundleExecutable is OMPdesk (the launcher)"
  plutil -extract CFBundleURLTypes.0.CFBundleURLSchemes.0 raw -o - "$app/Contents/Info.plist" | grep -Fxq omp; check $? "the omp:// URL scheme is registered"
  minos=$(plutil -extract LSMinimumSystemVersion raw -o - "$app/Contents/Info.plist")
  [ "$minos" = "$(jq -r .minimumMacOS <<<"$compat")" ] && [[ "$minos" == 14.* ]]; check $? "LSMinimumSystemVersion is $minos: app-compatibility.json's minimumMacOS at $TAG, and 14.x"
  record=$app/Contents/Resources/ompdesk-tauri.build.json
  [ "$(jq -r .engine "$record")" = tauri ] && [ "$(jq -r .platform "$record")" = darwin ] && [ "$(jq -c .features "$record")" = "[]" ]; check $? "the build record says engine tauri, platform darwin, no cargo features (no test automation)"
  host=$app/Contents/MacOS/$(jq -er .binary "$record"); launcher=$app/Contents/MacOS/OMPdesk
  for bin in "$host" "$launcher"; do
    codesign --verify --strict --verbose=2 "$bin" && lipo -archs "$bin" | grep -qx arm64; check $? "$(basename "$bin") is signed and arm64"
  done
  grep -c -E 'tauri-plugin-wdio-webdriver|tauri_plugin_wdio_webdriver|wdio-webdriver|wdio_webdriver' "$host" | grep -qx 0; check $? "the host binary holds no WebDriver plugin string"
  [ ! -e "$app/Contents/Frameworks/Chromium Embedded Framework.framework" ] && ! compgen -G "$app/Contents/Frameworks/OMPdesk Helper*.app" >/dev/null; check $? "no CEF framework and no CEF helper app in the package"
  [ -f "$app/Contents/Resources/gui-bridge/index.ts" ] && [ -f "$app/Contents/Resources/app/out/main/index.js" ] && [ -f "$app/Contents/Resources/app/out/preload/tauri.js" ]; check $? "gui-bridge, the main bundle and the Tauri preload are in the package"
  local pbbin; pbbin=$app/Contents/Resources/preview-browser/$(jq -er .binary "$app/Contents/Resources/preview-browser/runtime.json")
  codesign --verify --strict --verbose=2 "$pbbin"; check $? "Preview's browser runtime keeps its vendor signature ($(basename "$pbbin"))"
}

if [ "$PLATFORM" = mac ]; then verify_mac; else verify_win; fi
exit $FAILED
