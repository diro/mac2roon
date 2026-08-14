# mac2roon — 從一句 prompt 到把 Apple Music 無損串進 Roon

> 一個用 Claude Code 完成的實作紀錄:從一句需求,到一個能用、誠實、bit-perfect 的橋接器。

## 起點:那句 prompt

> 「Stream all audio from a Mac (primary purpose: **Apple Music**) to a **Roon** zone, with Roon-native now-playing, transport buttons, and zone selection. **lossless** audio quality.」

需求很短,但其實藏著一個矛盾:**Apple Music 要當來源** vs **要有 Roon 原生的現正播放/傳輸/選 zone**——這兩件事在 Roon 的架構下天生衝突。整個過程的價值,不在於「寫了多少 code」,而在於**先搞清楚什麼可行、什麼是平台硬限制,再把可行的部分做到位**。

## 成果 TL;DR

- Apple Music(及全部 Mac 音訊)以**無損 FLAC** 即時串進指定的 Roon zone,**實測零丟樣本**。
- Roon 的**現正播放**會逐曲更新曲名/演出者/專輯,而且**不中斷音訊**。
- 在 Roon 用**原生 zone 選擇器**選播放區域。
- **Bit-perfect**:逐曲取樣率自動跟隨(CD ↔ 高解析),全程不重採樣。
- 以 launchd 背景服務常駐,開機自動啟動。

公開原始碼:**https://github.com/diro/mac2roon**

## 為什麼這題不簡單

Roon 只會對「它自己的播放引擎來源」(本地音樂庫、TIDAL/Qobuz、網路電台)顯示完整的原生現正播放與傳輸。Apple Music 不是其中之一,而且 Apple Music 有 FairPlay DRM、沒有可取得乾淨音訊的公開 API。所以這題的第一步不是寫 code,是**研究可行性**。

## 工程歷程(每個轉折都有實證)

**1. 先研究,推翻一個普遍誤解。**
網路上常說「Roon 沒辦法吃外部音訊」。研究後發現這是**過時**的:Roon 有官方的 `node-roon-api-audioinput`(`com.roonlabs.audioinput:1`)服務,可以把一個 HTTP 串流注入成 zone 的來源,帶來源名稱、文字行、傳輸旗標。真正的死路在 **Apple 那一側**(DRM),不是 Roon。釐清這點,整個架構才定下來:**擷取系統音訊 → 編成 FLAC over HTTP → 用 audioinput 注入 Roon**。

**2. 破音 → 用量測找出真兇,而不是猜。**
第一版能播,但**破音**。直覺會去調 buffer、改參數;我選擇**量測**:直接擷取 12 秒,結果檔案只有 10.6 秒——再用 raw PCM、加大 thread queue 重測,**20.4 秒的錄製只得到 17.6 秒音訊**。結論明確:**ffmpeg 的 avfoundation 音訊擷取會掉約 13% 樣本**(這是已知的長年問題)。換成 **sox**(CoreAudio)重測:**20 秒 → 20.000 秒,零丟失**。破音根因是擷取層,不是 buffer。改用 `sox 擷取 + ffmpeg 只負責編碼`後解決。

**3. 只有實機才會現形的 bug:AppleScript 的保留字。**
讀 Music.app 現正播放的 osascript 一直回 null,但封面卻讀得到。打開 debug 才發現是語法錯誤 `-2741`。逐項隔離後抓到:變數名用了 `st`——**`st` 是 AppleScript 的保留字**。改名即修好。這種 bug 不播真實音樂、不接真實環境根本不會出現。

**4. 即時 debug 摸出未公開的 API 形狀。**
逐曲更新現正播放時,`update_track_info` 先回 `InvalidRequest: missing required string field: track_id`,加上 track_id 後又回 `TrackNotFound`。從真實回應推導出規則:**它只更新 play() 當初建立的那個 track_id**。於是設計成「整個 session 用一個固定的 channel track_id」——這樣音訊串流**一條到底不中斷**,而每首歌的文字用 `update_track_info` 更新,**達成無縫換曲**。

**5. 誠實面對平台限制,不硬凹。**
- **封面**:`image_url` 有送、本機端點也能正常回 600×600 JPEG,但實測 **Roon 從不來抓**——Roon 對 audioinput 來源就是不渲染逐曲封面。記為已知限制,不浪費力氣。
- **傳輸鍵**:即時無限串流被 Roon 當成**網路電台**,只給「停止」,不給暫停/切歌(`is_pause_allowed` 被 Roon 強制 false)。所以實際控制模型是「**用 Apple Music 控制、Roon 顯示+選 zone+停止**」,停止後在 Apple Music 按播放即自動奪回 zone(已驗證)。

**6. Bit-perfect:讓擷取跟著取樣率走。**
macOS 的 Music.app 不會自動切換輸出取樣率,所以搭 **LosslessSwitcher** 逐曲切換 BlackHole 的取樣率;橋接這端用 `system_profiler` 偵測到速率變動時,**以新的原生取樣率重啟串流**(同取樣率的換曲仍維持無縫)。全程不重採樣,24-bit FLAC 完整保留 ≤24-bit 內容。最終由 Roon 的 **Signal Path 顯示 Lossless** 作為整鏈 bit-perfect 的權威證明。

## 最終技術棧

| 層 | 用什麼 |
|---|---|
| 執行環境 | Node.js(純 ESM),零執行期框架,只用內建 `http`/`child_process` |
| Roon | `node-roon-api` + `audioinput`/`settings`/`status`/`transport`(RAAT 送到端點) |
| 擷取 | BlackHole 2ch(虛擬 loopback)→ **sox**(CoreAudio,無丟樣本) |
| 編碼/傳輸 | **ffmpeg** → Ogg-FLAC,Node `http` chunked 持續吐流,Roon 來拉 |
| Metadata/控制 | `osascript`(AppleScript)讀寫 Music.app;封面備援走 iTunes Search API |
| Bit-perfect | LosslessSwitcher + 橋接 rate-follow(偵測 → 重啟) |
| 常駐 | launchd LaunchAgent;switchaudio-osx 設輸出裝置 |

約 1,600 行,模組化拆成 `index / roon / audio-server / music / devices / config / util` + 自我測試與服務安裝腳本。

## 誠實的限制(寫在最前面,不藏)

- Roon 不顯示此類來源的**逐曲封面**(平台限制)。
- Roon 端傳輸只有**停止**(電台語意);播放控制請用 Apple Music。
- **延遲**幾秒,主要來自 Roon 與端點(此例為 Squeezebox Touch)對串流的緩衝,API 沒有旋鈕可調。
- 擷取的是**解碼後**的系統音訊(DRM 使然),品質等同解碼輸出——對 ≤24-bit 內容是無損的。
- Squeezebox Touch 原廠上限 24/96,192k 會被 Roon 降頻。

## 方法論心得

1. **先研究可行性再寫 code**:推翻「Roon 不能吃外部音訊」這個過時前提,整個方案才成立。
2. **量測,不要猜**:破音不是調 buffer,是用「20 秒只錄到 17.6 秒」這個數字直接定位到擷取層。
3. **實機才抓得到的 bug**:AppleScript 保留字、`update_track_info` 的隱藏欄位,都是接上真實 Roon Core 與真實 Apple Music 播放後才現形。
4. **誠實對待平台限制**:能做到的做到位,做不到的(封面、完整傳輸)講清楚為什麼——這比硬凹更有用、更可信。

---

*本實作由 Claude Code 完成,從一句需求 prompt 起,經過研究、實機除錯與多次驗證迭代而成。*
