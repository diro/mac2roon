# mac2roon 安裝教學(從零開始)

把 Mac 的 Apple Music 以**無損**串流到 **Roon zone**。以下從乾淨的 Mac 一步步做到能用,最後再做選配的 **bit-perfect** 與**背景常駐**。

---

## 0. 事前需求

- 一台 **macOS** 電腦(Apple Silicon 或 Intel)。
- 區網內有一台 **Roon Core**,且至少有一個可播放的 zone(任何 RAAT/Roon Ready/AirPlay/Squeezebox 端點)。
- 已安裝 **Homebrew**(沒有的話到 https://brew.sh 安裝)。

---

## 1. 安裝套件

```sh
# 必要:編碼器、無丟樣本的擷取工具、虛擬音訊裝置、輸出切換工具
brew install ffmpeg sox switchaudio-osx
brew install blackhole-2ch        # 虛擬 loopback 音訊裝置(簽章驅動)
brew install node                 # 若還沒有 Node(需 ≥ 20)
```

> 安裝完 **BlackHole 後請重新開機**(或登出再登入),驅動才會完整載入。

---

## 2. 取得程式並安裝相依

```sh
git clone https://github.com/diro/mac2roon.git
cd mac2roon
npm install                       # 抓 Roon API 套件(來自 GitHub)
```

確認擷取裝置有被看到:

```sh
npm run devices
# 應該列出 [n] BlackHole 2ch,並建議用它當預設
```

---

## 3. 把系統聲音導進 BlackHole

把 Mac 的**系統輸出**設成 **BlackHole 2ch**:

```sh
SwitchAudioSource -s "BlackHole 2ch"
# 或:系統設定 → 聲音 → 輸出 → 選 BlackHole 2ch
```

> 這樣 Mac 本機會「靜音」是**正常的**——聲音會從你的 **Roon zone** 喇叭出來,這正是目的。
> (若你也想在 Mac 本機聽到,可在「音訊 MIDI 設定」建立 Multi-Output Device 把真實喇叭 + BlackHole 一起選,但這會犧牲 bit-perfect。)

---

## 4. 先驗證音訊鏈(可跳過,但建議)

先放一首歌到 Apple Music,然後:

```sh
npm run test:audio "BlackHole 2ch" 15
# 通過會顯示:PASS — lossless FLAC captured at NNNNN Hz,且擷取時長 = 15 秒(零丟樣本)
```

---

## 5. 第一次啟動 + 授權

從**終端機**手動跑一次(這樣 macOS 才能跳出授權視窗):

```sh
npm start
```

macOS 會問「想要控制『音樂』」——按 **允許**(讀取現正播放需要這個權限)。
看到 log 出現 `Discovery started` 就代表在等 Roon 配對。

---

## 6. 在 Roon 啟用並設定

1. Roon → **設定 → 擴充功能(Settings → Extensions)**
2. 找到 **「Mac → Roon (Apple Music Bridge)」**,按 **Enable**
3. 按它的 **Settings**,設定:
   - **Roon zone**:你要播放的區域
   - **Capture device**:選 **BlackHole 2ch**
   - **Stream mode**:**Follow Apple Music**(跟著播放啟動)
   - **Per-track artwork**:On
4. 在 **Apple Music 播放**任一首歌 → 該 zone 就會出現這個來源並開始播。

✅ 到這裡就能用了。日常控制(播放/暫停/切歌)請用 **Apple Music**;Roon 端負責顯示現正播放、選 zone、停止。

---

## 7.(選配)Bit-perfect 無損

要逐曲 bit-perfect,需要讓 BlackHole 的取樣率跟著曲目走,並確保整條鏈都不動到 bit。

**a. 安裝並啟動 LosslessSwitcher**
```sh
brew install --cask losslessswitcher
open -a LosslessSwitcher          # 選單列 app;它會逐曲切換預設輸出的取樣率
```
(本橋接會偵測取樣率變動,並以新原生速率重啟串流。)

**b. Apple Music → 設定 → 播放**
- 音質:**無損 + 高解析無損** 開啟
- **Sound Check:關**、**EQ:關**、**杜比全景聲:關(Off,非自動)**

**c. 音量**:系統音量與 Apple Music 音量都拉到**最大(100%)**(低於 100% 會縮放樣本)。

**d. Roon zone 設定**:DSP Engine **關**、Volume Leveling **關**、音量模式設 **Fixed Volume**。

**e. 驗證**:在 Roon 現正播放點彩色圓點看 **Signal Path**,顯示 **「Lossless」(紫色)、無 sample rate conversion / volume 步驟** = 整鏈 bit-perfect。

> 端點上限:**Squeezebox Touch 原廠最高 24/96**,192k 會被 Roon 降頻(硬體限制)。

---

## 8.(選配)裝成開機背景服務

先照第 5 步在終端機跑過一次、授權過 Automation,再:

```sh
# ITUNES_COUNTRY 設成你的 Apple Music 地區(封面備援用),例如台灣 TW
ITUNES_COUNTRY=TW ./scripts/install-service.sh

launchctl list | grep mac2roon          # 確認在跑
tail -f /tmp/mac2roon.out               # 看 log
./scripts/uninstall-service.sh          # 之後要移除就跑這個
```

---

## 常見問題

- **破音**:確認擷取走 sox(本版預設)。用 `npm run test:audio` 檢查,擷取時長要等於指定秒數。
- **沒有現正播放/讀不到歌名**:到「系統設定 → 隱私權與安全性 → 自動化」允許控制「音樂」;裝成服務後若失效,從終端機再跑一次 `npm start` 重新授權。
- **顯示 Please configure zone / device**:到擴充功能 Settings 把 zone 和裝置都選好。
- **zone 沒聲音**:確認系統輸出是 BlackHole、且 Apple Music 正在播。
- **串流起不來**:試 `CONTAINER=flac npm start`。
- **在 Roon 按停止後跳到別的專輯**:正常——Roon 會把停掉的即時來源退回它自己的佇列。回到 Mac 來源請在 Apple Music 按播放。
- **沒有封面**:Roon 對這類來源不顯示逐曲封面(已知平台限制)。

---

## 環境變數(進階)

| 變數 | 預設 | 用途 |
|---|---|---|
| `PORT` | `4747` | HTTP 串流埠 |
| `ADVERTISE_HOST` | 自動偵測區網 IP | 交給 Roon 的網址主機(自動偵測錯誤時手動指定) |
| `CONTAINER` | `ogg` | `ogg`(Ogg-FLAC)或 `flac` |
| `ITUNES_COUNTRY` | `US` | 封面備援的 iTunes 商店地區(例如 `TW`) |
| `POLL_MS` | `700` | Music.app 輪詢間隔(毫秒) |
| `LOG_LEVEL` | `info` | `debug` 會印 Roon 協定細節 |
