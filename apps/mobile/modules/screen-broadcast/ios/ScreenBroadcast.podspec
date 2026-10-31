Pod::Spec.new do |s|
  s.name           = 'ScreenBroadcast'
  s.version        = '1.0.0'
  s.summary        = 'Diskort iOS ekran yayını: sistem seçicisi ve yayın eklentisi bildirimleri'
  s.author         = 'Diskort'
  s.homepage       = 'https://diskort.ziroo.net'
  s.license        = { type: 'UNLICENSED' }
  s.platforms      = { ios: '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'ReplayKit'
  s.source_files   = '*.swift'
end
