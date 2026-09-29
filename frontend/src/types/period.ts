/** Period 期别（项目共用，order 越小越早） */
export interface Period {
  id: string
  /** 期别名称，如 一期、汉代层 */
  name: string
  /** 排序序号，从 0 起，越小年代越早 */
  order: number
  /** 分期说明 */
  note: string
}

/** 未分期（未定年代）时的占位期别 id */
export const UNPERIODIZED = ''
