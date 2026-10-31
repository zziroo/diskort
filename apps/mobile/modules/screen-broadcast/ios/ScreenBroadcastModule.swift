import ExpoModulesCore
import ReplayKit
import UIKit

// Yayın eklentisi ayrı bir işlemdir (extension/SampleHandler.swift); haberleşme Darwin bildirimleriyle olur.
private let startedNotification = "com.diskort.broadcast.started"
private let stoppedNotification = "com.diskort.broadcast.stopped"
private let stopRequestNotification = "com.diskort.broadcast.stop"

public class ScreenBroadcastModule: Module {
  private var active = false
  private var picker: RPSystemBroadcastPickerView?

  public func definition() -> ModuleDefinition {
    Name("ScreenBroadcast")

    Events("onStarted", "onStopped")

    OnCreate {
      self.observe(startedNotification)
      self.observe(stoppedNotification)
    }

    OnDestroy {
      CFNotificationCenterRemoveEveryObserver(
        CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
    }

    AsyncFunction("isActive") { () -> Bool in
      self.active
    }.runOnQueue(.main)

    // Sistemin yayın seçicisini açar. Seçici yalnızca kendi düğmesine basılınca açıldığı için görünmez bir kopya
    // pencereye eklenip düğmesine basılır (Jitsi ve LiveKit örnekleri de böyle yapar). Sonuç (başlatıldı ya da
    // vazgeçildi) buradan dönmez: başlayınca eklentinin bildirimi gelir, vazgeçilirse hiçbir şey olmaz.
    AsyncFunction("showPicker") { () -> Bool in
      self.showPicker()
    }.runOnQueue(.main)

    Function("stop") {
      CFNotificationCenterPostNotification(
        CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(stopRequestNotification as CFString), nil, nil,
        true)
    }
  }

  private func observe(_ name: String) {
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque(),
      { _, observer, name, _, _ in
        guard let observer, let name else { return }
        Unmanaged<ScreenBroadcastModule>.fromOpaque(observer).takeUnretainedValue().handle(name.rawValue as String)
      },
      name as CFString, nil, .deliverImmediately)
  }

  private func handle(_ name: String) {
    active = name == startedNotification
    sendEvent(active ? "onStarted" : "onStopped")
  }

  private func showPicker() -> Bool {
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)
    guard let window else { return false }

    picker?.removeFromSuperview()
    let view = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    view.preferredExtension = Bundle.main.object(forInfoDictionaryKey: "RTCScreenSharingExtension") as? String
    view.showsMicrophoneButton = false
    view.alpha = 0
    window.addSubview(view)
    picker = view

    guard let button = firstButton(in: view) else { return false }
    button.sendActions(for: .touchUpInside)
    return true
  }

  private func firstButton(in view: UIView) -> UIButton? {
    for subview in view.subviews {
      if let button = subview as? UIButton ?? firstButton(in: subview) { return button }
    }
    return nil
  }
}
