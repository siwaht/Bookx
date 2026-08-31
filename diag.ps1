$ProgressPreference = 'SilentlyContinue'
$base = 'http://localhost:3001/api'
$login = Invoke-RestMethod -Uri "$base/auth/login" -Method Post -Body (@{ password = 'changeme' } | ConvertTo-Json) -ContentType 'application/json' -UseBasicParsing
$h = @{ Authorization = "Bearer $($login.token)"; 'Content-Type' = 'application/json' }
$out = @()

$books = Invoke-RestMethod -Uri "$base/books" -Headers $h -UseBasicParsing
foreach ($b in $books) {
  $chars = Invoke-RestMethod -Uri "$base/books/$($b.id)/characters" -Headers $h -UseBasicParsing
  $chapters = Invoke-RestMethod -Uri "$base/books/$($b.id)/chapters" -Headers $h -UseBasicParsing
  $voiced = @($chars | Where-Object { $_.voice_id }).Count
  $out += "BOOK '$($b.title)' [$($b.project_type)] id=$($b.id)"
  $out += "  characters=$($chars.Count) voiced=$voiced chapters=$($chapters.Count)"
  foreach ($c in $chars) {
    $v = if ($c.voice_id) { "$($c.voice_name) (id=$($c.voice_id)) provider=$($c.tts_provider)" } else { 'NO VOICE' }
    $out += "    - $($c.name) [$($c.role)] lines=$($c.line_count) -> $v"
  }
  foreach ($ch in $chapters) {
    $segs = Invoke-RestMethod -Uri "$base/chapters/$($ch.id)/segments" -Headers $h -UseBasicParsing
    $withChar = @($segs | Where-Object { $_.character_id }).Count
    $withAudio = @($segs | Where-Object { $_.audio_asset_id }).Count
    $out += "    chapter '$($ch.title)': segments=$($segs.Count) with_character=$withChar with_audio=$withAudio"
    $orphan = @($segs | Where-Object { $_.character_id -and -not ($chars.id -contains $_.character_id) })
    if ($orphan.Count -gt 0) {
      $out += "      !! $($orphan.Count) segment(s) point at a character_id that is NOT in this book's character list"
      foreach ($o in ($orphan | Select-Object -First 3)) { $out += "         seg=$($o.id) character_id=$($o.character_id)" }
    }
  }
  $out += ''
}
$out | Out-File diag.txt -Encoding utf8
Write-Output 'done'
