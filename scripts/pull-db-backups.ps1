# Sunucudaki Diskort yedeklerini bu bilgisayara (varsayılan: OneDrive klasörü) indirir: en son veritabanı
# yedeğini, dosya eklerinin (mesajlardaki resim/dosyalar), profil fotoğraflarının, geri bildirim ekran
# görüntülerinin, giriş seslerinin ve ses paneli seslerinin aynasını. Böylece sunucu tamamen kaybolsa bile
# yedek bulutta kalır. Windows Görev Zamanlayıcı her gün çalıştırır.
# Elle çalıştırmak için: powershell -ExecutionPolicy Bypass -File scripts\pull-db-backups.ps1
param(
  [string]$Server = 'root@38.60.208.88',
  [string]$Key = "$env:USERPROFILE\.ssh\diskort_vps",
  [string]$Destination = "$(if ($env:OneDrive) { $env:OneDrive } else { $env:USERPROFILE })\Yedekler\Diskort",
  # Dosya ekleri (boşsa: <Destination>\ekler)
  [string]$AttachmentsDestination = '',
  [int]$KeepDays = 60
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Destination | Out-Null
$log = Join-Path $Destination 'yedek-gunlugu.txt'
$sshArgs = @('-i', $Key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20')
$remoteRoot = '/var/backups/diskort'

function Invoke-Remote([string]$Command) {
  $output = & ssh @sshArgs $Server $Command
  if ($LASTEXITCODE -ne 0) { throw "Sunucu komutu başarısız (ssh kodu $LASTEXITCODE): $Command" }
  return $output
}

# Sunucudaki bir klasörü buraya aynalar. Dosyalar hiç değişmediği için yalnızca eksik olanlar indirilir;
# sunucuda süresi dolup silinenler (silinen mesajların dosyaları, 30 gün sonra) buradan da silinir.
function Sync-Mirror([string]$RemoteDir, [string]$LocalDir, [string]$Pattern, [string]$Label) {
  New-Item -ItemType Directory -Force $LocalDir | Out-Null
  $listing = Invoke-Remote "if test -d $RemoteDir; then ls -1 $RemoteDir; fi"
  $remote = [System.Collections.Generic.HashSet[string]]::new()
  foreach ($line in @($listing)) { if ("$line" -match $Pattern) { [void]$remote.Add("$line") } }
  $local = @(Get-ChildItem $LocalDir -File | Where-Object Name -Match $Pattern | Select-Object -ExpandProperty Name)
  $localSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$local)
  $missing = @($remote | Where-Object { -not $localSet.Contains($_) })

  # Toplu indirme: sunucuda tar paketi yapılır, tek seferde indirilip açılır (komut satırı sınırı için 400'erli)
  $tempTar = Join-Path $env:TEMP 'diskort-yedek.tar'
  for ($i = 0; $i -lt $missing.Count; $i += 400) {
    $batch = $missing[$i..([math]::Min($i + 399, $missing.Count - 1))]
    $remoteTar = "/tmp/diskort-yedek-$PID.tar"
    Invoke-Remote "cd $RemoteDir && tar -cf $remoteTar $($batch -join ' ')" | Out-Null
    try {
      & scp @sshArgs -q "${Server}:$remoteTar" $tempTar
      if ($LASTEXITCODE -ne 0) { throw "$Label indirilemedi (scp kodu $LASTEXITCODE)" }
    } finally {
      & ssh @sshArgs $Server "rm -f $remoteTar" | Out-Null
    }
    & tar -xf $tempTar -C $LocalDir
    if ($LASTEXITCODE -ne 0) { throw "$Label paketi açılamadı (tar kodu $LASTEXITCODE)" }
    Remove-Item $tempTar -Force
  }

  # Sunucu hiç dosya bildirmediyse (beklenmedik durum) hiçbir şey silinmez
  $removed = 0
  if ($remote.Count -gt 0) {
    foreach ($file in $local) {
      if (-not $remote.Contains($file)) {
        Remove-Item (Join-Path $LocalDir $file) -Force
        $removed++
      }
    }
  }
  return "${Label}: $($remote.Count) dosya, yeni $($missing.Count), silinen $removed"
}

try {
  # 1) Veritabanı: en son yedek
  $name = & ssh @sshArgs $Server 'readlink /var/backups/diskort/latest.db.gz'
  if ($LASTEXITCODE -ne 0 -or -not $name) { throw "Sunucuya bağlanılamadı veya yedek yok (ssh kodu $LASTEXITCODE)" }
  $name = "$name".Trim()

  $target = Join-Path $Destination $name
  if (Test-Path $target) {
    $status = "zaten var"
  } else {
    & scp @sshArgs -q "${Server}:/var/backups/diskort/$name" $target
    if ($LASTEXITCODE -ne 0) { throw "İndirme başarısız (scp kodu $LASTEXITCODE)" }
    $status = "indirildi ($([math]::Round((Get-Item $target).Length / 1KB, 1)) KB)"
  }

  Get-ChildItem $Destination -Filter 'diskort-*.db.gz' |
    Where-Object LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) |
    Remove-Item -Force

  # 2) Dosya ekleri, profil fotoğrafları, geri bildirim görüntüleri, giriş sesleri ve ses paneli sesleri: sunucudaki günlük kopyanın aynası
  #    (infra/backup-attachments.sh)
  $attachments = if ($AttachmentsDestination) { $AttachmentsDestination } else { Join-Path $Destination 'ekler' }
  $attachmentStatus = @(
    (Sync-Mirror "$remoteRoot/attachments" $attachments '^[0-9a-f]{32}$' 'ekler'),
    (Sync-Mirror "$remoteRoot/avatars" (Join-Path $Destination 'profil-fotograflari') '^[0-9a-f]{32}\.webp$' 'profil fotoğrafları'),
    (Sync-Mirror "$remoteRoot/feedback" (Join-Path $Destination 'geri-bildirim') '^[0-9a-f]{32}\.webp$' 'geri bildirim görüntüleri'),
    (Sync-Mirror "$remoteRoot/intro-sounds" (Join-Path $Destination 'giris-sesleri') '^[0-9a-f]{32}\.mp3$' 'giriş sesleri'),
    (Sync-Mirror "$remoteRoot/sounds" (Join-Path $Destination 'ses-paneli') '^[0-9a-f]{32}\.mp3$' 'ses paneli sesleri')
  ) -join '; '

  "$(Get-Date -Format 'yyyy-MM-dd HH:mm') TAMAM  $name $status; $attachmentStatus" | Add-Content -Encoding UTF8 $log
} catch {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm') HATA   $($_.Exception.Message)" | Add-Content -Encoding UTF8 $log
  exit 1
}
