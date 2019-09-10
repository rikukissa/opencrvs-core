import {
  IFormField,
  IFormData,
  TransformedData,
  SEARCH_FIELD,
  ISearchFormField,
  IDynamicFormField
} from '@register/forms'
import { IDynamicValues } from '@opencrvs/components/lib/interface/GridTable/types'

export const birthEventLocationMutationTransformer = (
  lineNumber: number = 0,
  transformedFieldName?: string
) => (
  transformedData: TransformedData,
  draftData: IFormData,
  sectionId: string,
  field: IFormField
) => {
  if (!transformedData.eventLocation) {
    transformedData.eventLocation = {
      address: {
        country: '',
        state: '',
        district: '',
        postalCode: '',
        line: ['', '', '', '', '', '']
      }
    } as fhir.Location
  }
  if (lineNumber > 0) {
    transformedData.eventLocation.address.line[lineNumber - 1] =
      draftData[sectionId][field.name]
  } else if (field.name === 'placeOfBirth') {
    transformedData.eventLocation.type = draftData[sectionId][field.name]
  } else if (field.name === 'birthLocation') {
    if (field.type === SEARCH_FIELD) {
      transformedData.eventLocation._fhirID = (draftData[sectionId][
        field.name
      ] as IDynamicValues).value
    } else {
      transformedData.eventLocation._fhirID = draftData[sectionId][field.name]
    }
    if (transformedData.eventLocation.address) {
      delete transformedData.eventLocation.address
    }
    if (transformedData.eventLocation.type) {
      delete transformedData.eventLocation.type
    }
  } else if (transformedFieldName) {
    transformedData.eventLocation.address[transformedFieldName] =
      draftData[sectionId][field.name]
  } else {
    transformedData.eventLocation.address[field.name] =
      draftData[sectionId][field.name]
  }
  if (field.name === 'addressLine4') {
    transformedData.eventLocation.partOf = `Location/${
      draftData[sectionId][field.name]
    }`
  }

  return transformedData
}