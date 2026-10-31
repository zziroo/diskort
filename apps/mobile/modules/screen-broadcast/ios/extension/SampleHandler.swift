import CoreImage
import CoreMedia
import Darwin
import Foundation
import ReplayKit

// iOS sistem geneli ekran yayını: ReplayKit bu eklentiye kareleri verir, eklenti de onları App Group kapsayıcısındaki
// "rtc_SSFD" soketi üzerinden ana uygulamaya (@livekit/react-native-webrtc, ScreenCapturer.m) yollar. Kodlama ve
// gönderme ana uygulamada olur; eklentinin 50 MB bellek sınırı var, burada yalnızca küçültme ve JPEG yapılır.
//
// Mesaj biçimi kütüphanenin okuduğu biçimdir: HTTP yanıtı (başlıklar: Content-Length, Buffer-Width, Buffer-Height,
// Buffer-Orientation) ve gövdede JPEG. Akış: docs/ios.md, "Ekran yayını".

/** Gönderilen görüntünün kısa kenarı (piksel). Telefonda VP8 yazılımla kodlanır; daha büyüğüne işlemci yetişmez */
private let shortSideLimit: CGFloat = 720
/** Saniyede en çok kaç kare (voice.ts'teki maxFramerate ile aynı). ReplayKit 60'a kadar verir */
private let maxFramesPerSecond = 24.0
private let jpegQuality: Float = 0.8
/** Ana uygulama bu sürede soketi açmazsa yayın bitirilir (uygulama kapalı ya da ses kanalında değil) */
private let connectTimeout: TimeInterval = 8
/** Ekran değişmezken ReplayKit kare vermez; yeni izleyici boş kalmasın diye son kare yeniden gönderilir */
private let repeatInterval: TimeInterval = 1
private let socketName = "rtc_SSFD"

/** Eklenti ile ana uygulama arasındaki Darwin bildirimleri (ScreenBroadcastModule.swift ile aynı adlar) */
private let startedNotification = "com.diskort.broadcast.started"
private let stoppedNotification = "com.diskort.broadcast.stopped"
private let stopRequestNotification = "com.diskort.broadcast.stop"

private func postDarwin(_ name: String) {
  CFNotificationCenterPostNotification(
    CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
}

final class SampleHandler: RPBroadcastSampleHandler {
  private let sender = FrameSender()
  private let encoder = FrameEncoder()
  private var lastFrameAt: CFTimeInterval = 0
  private var finished = false
  private let finishLock = NSLock()

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    CFNotificationCenterAddObserver(
      center, Unmanaged.passUnretained(self).toOpaque(),
      { _, observer, _, _, _ in
        guard let observer else { return }
        Unmanaged<SampleHandler>.fromOpaque(observer).takeUnretainedValue().finishQuietly()
      },
      stopRequestNotification as CFString, nil, .deliverImmediately)

    sender.onClosed = { [weak self] in self?.finishQuietly() }
    sender.onConnectTimeout = { [weak self] in
      self?.finish(reason: "Önce Diskort'ta bir ses kanalına katıl, sonra yayını başlat.")
    }
    sender.start(socketPath: socketPath)
    postDarwin(startedNotification)
  }

  override func broadcastFinished() {
    _ = cleanUp()
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    guard sampleBufferType == .video, sender.isReady else { return }
    let now = CACurrentMediaTime()
    guard now - lastFrameAt >= 1 / maxFramesPerSecond else { return }
    lastFrameAt = now
    // CIContext geçici nesneleri kare başına boşaltılmazsa 50 MB sınırına hızla ulaşılır
    autoreleasepool {
      if let message = encoder.encode(sampleBuffer) { sender.send(message) }
    }
  }

  private var socketPath: String? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "RTCAppGroupIdentifier") as? String else { return nil }
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
      .appendingPathComponent(socketName).path
  }

  /** İlk çağrıda true: soket kapanması ile durdurma isteği aynı anda gelebilir */
  private func cleanUp() -> Bool {
    finishLock.lock()
    defer { finishLock.unlock() }
    if finished { return false }
    finished = true
    CFNotificationCenterRemoveEveryObserver(
      CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
    sender.stop()
    postDarwin(stoppedNotification)
    return true
  }

  /** Yayını kullanıcıya hata göstermeden bitirir: ana uygulama durdurdu ya da soketi kapattı */
  private func finishQuietly() {
    guard cleanUp() else { return }
    // Belgelenmemiş: nil hata iOS'un "yayın durdu" uyarısını çıkarmaz (LiveKit'in Swift SDK'sı da böyle yapar).
    // Swift imzası nil kabul etmez, seçiciyle çağrılır.
    perform(NSSelectorFromString("finishBroadcastWithError:"), with: nil)
  }

  /** Yayını iOS'un uyarısında görünecek nedenle bitirir */
  private func finish(reason: String) {
    guard cleanUp() else { return }
    finishBroadcastWithError(
      NSError(domain: RPRecordingErrorDomain, code: 10001, userInfo: [NSLocalizedDescriptionKey: reason]))
  }
}

/** Kareyi küçültüp JPEG'li mesaja çevirir */
private final class FrameEncoder {
  private let context = CIContext(options: [.cacheIntermediates: false, .workingColorSpace: NSNull()])
  private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

  func encode(_ sampleBuffer: CMSampleBuffer) -> Data? {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
    let width = CGFloat(CVPixelBufferGetWidth(pixelBuffer))
    let height = CGFloat(CVPixelBufferGetHeight(pixelBuffer))
    let shortSide = min(width, height)
    let scale = shortSide > shortSideLimit ? shortSideLimit / shortSide : 1
    let image = CIImage(cvPixelBuffer: pixelBuffer).transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let options = [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: jpegQuality]
    guard let jpeg = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: options) else { return nil }

    let orientation =
      (CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber)?
      .uint32Value ?? CGImagePropertyOrientation.up.rawValue
    let response = CFHTTPMessageCreateResponse(nil, 200, nil, kCFHTTPVersion1_1).takeRetainedValue()
    let headers = [
      "Content-Length": String(jpeg.count),
      "Buffer-Width": String(Int((width * scale).rounded())),
      "Buffer-Height": String(Int((height * scale).rounded())),
      "Buffer-Orientation": String(orientation),
    ]
    for (name, value) in headers {
      CFHTTPMessageSetHeaderFieldValue(response, name as CFString, value as CFString)
    }
    CFHTTPMessageSetBody(response, jpeg as CFData)
    return CFHTTPMessageCopySerializedMessage(response)?.takeRetainedValue() as Data?
  }
}

/**
 * Ana uygulamanın dinlediği Unix soketine bağlanır ve kareleri gönderir. Hepsi tek seri kuyrukta çalışır; gönderim
 * sürerken gelen kareler atlanır (isReady), ReplayKit'in kuyruğu beklemez.
 */
private final class FrameSender {
  var onClosed: (() -> Void)?
  var onConnectTimeout: (() -> Void)?

  private let queue = DispatchQueue(label: "com.diskort.broadcast.sender", qos: .userInteractive)
  private let lock = NSLock()
  private var busy = false
  private var connected = false
  private var fd: Int32 = -1
  private var connectTimer: DispatchSourceTimer?
  private var repeatTimer: DispatchSourceTimer?
  private var closedWatcher: DispatchSourceRead?
  private var lastMessage: Data?
  private var lastSentAt: CFTimeInterval = 0

  var isReady: Bool {
    lock.lock()
    defer { lock.unlock() }
    return connected && !busy
  }

  func start(socketPath: String?) {
    let startedAt = CACurrentMediaTime()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(100))
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      if let socketPath, self.connect(socketPath) {
        self.connectTimer?.cancel()
        self.connectTimer = nil
        self.didConnect()
      } else if CACurrentMediaTime() - startedAt > connectTimeout {
        self.connectTimer?.cancel()
        self.connectTimer = nil
        self.onConnectTimeout?()
      }
    }
    connectTimer = timer
    timer.resume()
  }

  func stop() {
    queue.async { [self] in
      connectTimer?.cancel()
      connectTimer = nil
      disconnect()
    }
  }

  func send(_ message: Data) {
    lock.lock()
    busy = true
    lock.unlock()
    queue.async { [self] in
      lastMessage = message
      write(message)
    }
  }

  private func connect(_ path: String) -> Bool {
    let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard socket >= 0 else { return false }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard path.utf8.count < capacity else {
      close(socket)
      return false
    }
    _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { strlcpy($0, path, capacity) }
    }
    let result = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard result == 0 else {
      close(socket)
      return false
    }
    // Karşı taraf kapanınca işlem SIGPIPE ile ölmesin; takılırsa kuyruk sonsuza dek beklemesin
    var on: Int32 = 1
    setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    fd = socket
    return true
  }

  private func didConnect() {
    let socket = fd
    // Ana uygulama yazmaz: okunabilir olmak yalnızca bağlantının kapandığı anlamına gelir
    let watcher = DispatchSource.makeReadSource(fileDescriptor: socket, queue: queue)
    watcher.setEventHandler { [weak self] in
      var byte: UInt8 = 0
      let count = recv(socket, &byte, 1, MSG_DONTWAIT)
      if count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR) { self?.connectionLost() }
    }
    watcher.setCancelHandler { close(socket) }
    closedWatcher = watcher
    watcher.resume()

    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + repeatInterval, repeating: repeatInterval)
    timer.setEventHandler { [weak self] in self?.repeatLastFrame() }
    repeatTimer = timer
    timer.resume()

    lock.lock()
    connected = true
    lock.unlock()
  }

  private func repeatLastFrame() {
    guard fd >= 0, CACurrentMediaTime() - lastSentAt >= repeatInterval, let lastMessage, isReady else { return }
    send(lastMessage)
  }

  private func write(_ message: Data) {
    guard fd >= 0 else { return }
    let sent = message.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Bool in
      var offset = 0
      while offset < buffer.count {
        let count = Darwin.send(fd, buffer.baseAddress! + offset, buffer.count - offset, 0)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { return false }
        offset += count
      }
      return true
    }
    lastSentAt = CACurrentMediaTime()
    lock.lock()
    busy = false
    lock.unlock()
    if !sent { connectionLost() }
  }

  private func connectionLost() {
    guard fd >= 0 else { return }
    disconnect()
    onClosed?()
  }

  private func disconnect() {
    lock.lock()
    connected = false
    lock.unlock()
    repeatTimer?.cancel()
    repeatTimer = nil
    closedWatcher?.cancel()
    closedWatcher = nil
    fd = -1
    lastMessage = nil
  }
}
