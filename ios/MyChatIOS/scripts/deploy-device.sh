#!/bin/zsh
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
project_path="$repo_root/ios/MyChatIOS/MyChatIOS.xcodeproj"
build_path="$repo_root/.device-build-native"
device_id="${MYCHAT_DEVICE_ID:-DEE9D44F-8BF7-5740-BC78-3CA4437F3FE8}"
app_path="$build_path/Build/Products/Debug-iphoneos/MyChatIOS.app"

branch="$(git -C "$repo_root" branch --show-current)"
if [[ "$branch" != "codex/native-ios-client" ]]; then
  print -u2 "Refusing device deployment from branch: $branch"
  exit 2
fi

xcodebuild \
  -project "$project_path" \
  -scheme MyChatIOS \
  -configuration Debug \
  -destination "id=$device_id" \
  -derivedDataPath "$build_path" \
  build

if [[ ! -d "$app_path" ]]; then
  print -u2 "Built app not found: $app_path"
  exit 3
fi

xcrun devicectl device install app --device "$device_id" "$app_path"
xcrun devicectl device process launch --terminate-existing --device "$device_id" com.mychat.ios
xcrun devicectl device info apps --device "$device_id" --bundle-id com.mychat.ios
