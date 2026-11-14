# Install board-lab into a DSH profile from this checkout.
param([string]$Profile = "web")
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "board-lab -> profile '$Profile' ($dir)"
dsh plugin --profile $Profile add $dir
