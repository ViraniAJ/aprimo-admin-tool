export type ClassificationNode = {
  id: string
  name: string
  labelPath: string
  parentId?: string
  labels?: Array<{ languageId: string; value: string }>
}
