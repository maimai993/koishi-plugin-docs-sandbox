/**
 * 控制台页面：把 /sandbox 的独立界面套进控制台。
 * 这里不打包 —— 控制台会把 'vue'、'@koishijs/client' 这类裸导入
 * 改写成它自带的 ../vue.js / ../client.js，所以手写 ESM 就够了。
 */
import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import { send } from '@koishijs/client'

export const name = 'docs-sandbox-console'

const FALLBACK_ASIDE = 64
const FALLBACK_STATUS = 28

export function apply(ctx) {
  ctx.page({
    name: '在线沙盒',
    path: '/docs-sandbox',
    desc: '真机试跑 bot 指令，界面与文档站共用同一个沙盒服务',
    authority: 1,
    icon: 'activity:terminal',
    component: defineComponent({
      setup() {
        const style = ref({})
        const src = ref('')
        const failed = ref('')
        let timer = null

        const sync = () => {
          const aside = document.querySelector('nav.layout-activity')
          const footer = document.querySelector('footer.layout-status')
          const left = aside ? Math.round(aside.getBoundingClientRect().right) || FALLBACK_ASIDE : FALLBACK_ASIDE
          const bottom = (footer ? Math.round(footer.getBoundingClientRect().height) : FALLBACK_STATUS) + 8
          style.value = {
            position: 'fixed',
            left: left + 'px',
            top: '0px',
            width: 'calc(100vw - ' + left + 'px)',
            height: 'calc(100vh - ' + bottom + 'px)',
            border: '0',
            display: 'block',
            background: 'transparent',
            zIndex: '1',
          }
        }

        const resolveTarget = async () => {
          try {
            const info = await send('docs-sandbox/status')
            src.value = (info && info.path) || '/sandbox'
          } catch (error) {
            failed.value = String((error && error.message) || error)
            src.value = '/sandbox'
          }
        }

        onMounted(() => {
          sync()
          timer = setInterval(sync, 1000)
          window.addEventListener('resize', sync)
          void resolveTarget()
        })
        onUnmounted(() => {
          if (timer) clearInterval(timer)
          window.removeEventListener('resize', sync)
        })

        return () => {
          if (src.value) return h('iframe', { src: src.value, style: style.value, title: '在线沙盒' })
          return h('div', { style: { padding: '32px', color: 'var(--k-text-dark, #666)' } },
            failed.value ? '读取沙盒地址失败：' + failed.value : '正在连接沙盒…')
        }
      },
    }),
  })
}
