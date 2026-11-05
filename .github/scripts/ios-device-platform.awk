# Read the load commands for one ARM64 slice. Simulator and device can both
# be ARM64; platform identity comes from the Mach-O header, not the filename.
$1 == "cmd" && $2 == "LC_BUILD_VERSION" { modern++ }
$1 == "cmd" && $2 == "LC_VERSION_MIN_IPHONEOS" { legacy++ }
$1 == "platform" {
  platforms++
  if ($2 != "2" && toupper($2) != "IOS") bad = 1
}
END { exit !(!bad && ((modern == 1 && platforms == 1 && !legacy) || (legacy == 1 && !modern && !platforms))) }
