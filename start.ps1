# First launch installs a private Python runtime and binary RAW wheels.
# It never requires administrator rights or touches the user's system Python.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$appRoot = $PSScriptRoot
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'Framekeep\runtime-py312-v1'
$python = Join-Path $runtimeRoot 'python.exe'
$ready = Join-Path $runtimeRoot 'ready-v1'
$runtimeCheck = Join-Path $appRoot 'local\check_runtime.py'

function Download-Verified($url, $target, $hash) {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $target
    if ((Get-FileHash -Algorithm SHA256 $target).Hash.ToLower() -ne $hash.ToLower()) {
        Remove-Item $target -Force
        throw 'Download checksum failed. Please try again.'
    }
}

try {
    # Run a file: Windows PowerShell can drop embedded quotes in native -c arguments.
    # Also recover installations whose packages succeeded before the old check failed.
    $componentsReady = $false
    if (Test-Path $python) {
        & $python $runtimeCheck
        $componentsReady = ($LASTEXITCODE -eq 0)
    }
    if ($componentsReady) {
        Set-Content -Encoding ASCII -Path $ready -Value '1'
    } elseif (Test-Path $ready) {
        Remove-Item $ready -Force
    }
    if (-not (Test-Path $ready)) {
        Write-Host 'First launch: installing local image / RAW components. Internet is needed once.'
        New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
        $download = Join-Path $runtimeRoot 'python.zip'
        # Digest from the release's official SPDX SBOM, CPython package.
        Download-Verified 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' $download '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'
        Expand-Archive -LiteralPath $download -DestinationPath $runtimeRoot -Force
        Remove-Item $download -Force
        $packages = Join-Path $runtimeRoot 'Lib\site-packages'
        New-Item -ItemType Directory -Force -Path $packages | Out-Null
        Set-Content -Encoding ASCII -Path (Join-Path $runtimeRoot 'python312._pth') -Value "python312.zip`n.`nLib\site-packages`nimport site"
        # Bootstrap pip from its verified wheel, rather than running a downloaded script.
        $pip = Invoke-RestMethod 'https://pypi.org/pypi/pip/25.0.1/json'
        $wheel = $pip.urls | Where-Object { $_.filename -eq 'pip-25.0.1-py3-none-any.whl' } | Select-Object -First 1
        if (-not $wheel) { throw 'Could not find the pip wheel.' }
        $pipZip = Join-Path $runtimeRoot 'pip.zip'
        Download-Verified $wheel.url $pipZip $wheel.digests.sha256
        Expand-Archive -LiteralPath $pipZip -DestinationPath $packages -Force
        Remove-Item $pipZip -Force
        & $python -m pip install --only-binary=:all: --disable-pip-version-check -r (Join-Path $appRoot 'local\requirements.txt')
        if ($LASTEXITCODE -ne 0) { throw 'Image components could not be installed. Check your connection and run Start again.' }
        & $python $runtimeCheck
        if ($LASTEXITCODE -ne 0) { throw 'Image components failed their startup check.' }
        Set-Content -Encoding ASCII -Path $ready -Value '1'
    }
    & $python (Join-Path $appRoot 'local\server.py')
    if ($LASTEXITCODE -ne 0) { throw 'Framekeep stopped unexpectedly. Please keep the error message.' }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'Nothing has been changed in your photo folders.'
    Read-Host 'Press Enter to close'
    exit 1
}
