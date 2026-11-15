import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'YuChao';
/** 与 Android 壳同一个入口：改前端后无需重发安装包 */
const HOME_URL: string = 'https://www.neoix.cloud/';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State private loading: boolean = true;
  @State private failed: boolean = false;

  /** 系统返回键：优先回退网页历史，退到头才交给系统（退出/回桌面） */
  onBackPress(): boolean {
    if (this.controller.accessBackward()) {
      this.controller.backward();
      return true;
    }
    return false;
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Web({ src: HOME_URL, controller: this.controller })
        .width('100%')
        .height('100%')
        .backgroundColor('#0A0A0B')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(false)
        .geolocationAccess(false)
        .zoomAccess(false)
        .multiWindowAccess(false)
        .cacheMode(CacheMode.Default)
        .mixedMode(MixedMode.None)
        .darkMode(WebDarkMode.On)
        .forceDarkAccess(false)
        .verticalScrollBarAccess(false)
        .onPageEnd(() => {
          this.loading = false;
          this.failed = false;
        })
        .onErrorReceive(() => {
          this.loading = false;
          this.failed = true;
          hilog.warn(0x0000, TAG, 'page load error');
        })

      if (this.loading) {
        Column({ space: 12 }) {
          LoadingProgress()
            .width(38)
            .height(38)
            .color('#FF9F43')
          Text('加载看盘工作台…')
            .fontSize(12)
            .fontColor('#8A8A8E')
        }
      }

      if (this.failed) {
        Column({ space: 10 }) {
          Text('网络不可达')
            .fontSize(14)
            .fontColor('#E5E5EA')
          Text('检查网络后重试')
            .fontSize(12)
            .fontColor('#8A8A8E')
          Button('重试')
            .fontSize(13)
            .height(34)
            .backgroundColor('#FF9F43')
            .fontColor('#0A0A0B')
            .onClick(() => {
              this.loading = true;
              this.failed = false;
              this.controller.loadUrl(HOME_URL);
            })
        }
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0A0A0B')
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
