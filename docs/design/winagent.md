$u='https://192.168.2.110/edge/windows/ongrid-edge-installer.exe'
$f="$env:TEMP\ongrid-edge-installer.exe"
(New-Object Net.WebClient).DownloadFile($u,$f)
& $f --manager-url https://192.168.2.110 --access-key Glxze9ssQRDFMc8dN6cQP8Up --secret-key Hl0GeLsPwaJVEydDiTw0mmDrI5bT3UdT --server-edge-addr 192.168.2.110:40012