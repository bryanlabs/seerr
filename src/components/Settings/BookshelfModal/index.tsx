import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { Transition } from '@headlessui/react';
import type { BookshelfSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import * as Yup from 'yup';

interface BookshelfTestResponse {
  profiles: { id: number; name: string }[];
  metadataProfiles: { id: number; name: string }[];
  rootFolders: { id: number; path: string }[];
  tags: { id: number; label: string }[];
  urlBase?: string;
}

const messages = defineMessages('components.Settings.BookshelfModal', {
  createbookshelf: 'Add New Bookshelf Server',
  editbookshelf: 'Edit Bookshelf Server',
  validationNameRequired: 'You must provide a server name',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  validationApiKeyRequired: 'You must provide an API key',
  validationRootFolderRequired: 'You must select a root folder',
  validationProfileRequired: 'You must select a quality profile',
  validationMetadataProfileRequired: 'You must select a metadata profile',
  validationMediaTypeRequired: 'You must select a media type',
  toastBookshelfTestSuccess: 'Bookshelf connection established successfully!',
  toastBookshelfTestFailure: 'Failed to connect to Bookshelf.',
  add: 'Add Server',
  defaultserver: 'Default Server',
  servername: 'Server Name',
  mediaType: 'Media Type',
  mediaTypeAudiobook: 'Audiobook',
  mediaTypeEbook: 'Ebook',
  mediaTypeHelp:
    'Whether this Bookshelf instance handles audiobooks or ebooks. One default server per type.',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  ssl: 'Use SSL',
  apiKey: 'API Key',
  apiKeyHelp:
    'Find it in Bookshelf: Settings > General > Security > API Key (or grep ApiKey from /config/config.xml).',
  baseUrl: 'URL Base',
  baseUrlHelp:
    'If you set a URL Base in Bookshelf (Settings > General > Host), enter it here. Leave blank otherwise.',
  externalUrl: 'External URL',
  externalUrlHelp:
    'For clickable links on media pages when the hostname is not reachable from outside your network.',
  qualityprofile: 'Quality Profile',
  metadataprofile: 'Metadata Profile',
  rootfolder: 'Root Folder',
  selectQualityProfile: 'Select quality profile',
  selectMetadataProfile: 'Select metadata profile',
  selectRootFolder: 'Select root folder',
  loadingprofiles: 'Loading profiles…',
  testFirstQualityProfiles: 'Test connection to load profiles',
  validationApplicationUrl: 'You must provide a valid URL',
  validationApplicationUrlTrailingSlash: 'URL must not end in a trailing slash',
  validationBaseUrlLeadingSlash: 'URL base must have a leading slash',
  validationBaseUrlTrailingSlash: 'URL base must not end in a trailing slash',
});

interface BookshelfModalProps {
  bookshelf: BookshelfSettings | null;
  onClose: () => void;
  onSave: () => void;
}

const BookshelfModal = ({
  onClose,
  bookshelf,
  onSave,
}: BookshelfModalProps) => {
  const intl = useIntl();
  const initialLoad = useRef(false);
  const { addToast } = useToasts();
  const [isValidated, setIsValidated] = useState(bookshelf ? true : false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResponse, setTestResponse] = useState<BookshelfTestResponse>({
    profiles: [],
    metadataProfiles: [],
    rootFolders: [],
    tags: [],
  });

  const BookshelfSettingsSchema = Yup.object().shape({
    name: Yup.string().required(
      intl.formatMessage(messages.validationNameRequired)
    ),
    mediaType: Yup.mixed<'audiobook' | 'ebook'>()
      .oneOf(['audiobook', 'ebook'])
      .required(intl.formatMessage(messages.validationMediaTypeRequired)),
    hostname: Yup.string().required(
      intl.formatMessage(messages.validationHostnameRequired)
    ),
    port: Yup.number()
      .nullable()
      .required(intl.formatMessage(messages.validationPortRequired)),
    apiKey: Yup.string().required(
      intl.formatMessage(messages.validationApiKeyRequired)
    ),
    rootFolder: Yup.string().required(
      intl.formatMessage(messages.validationRootFolderRequired)
    ),
    activeProfileId: Yup.string().required(
      intl.formatMessage(messages.validationProfileRequired)
    ),
    activeMetadataProfileId: Yup.string().required(
      intl.formatMessage(messages.validationMetadataProfileRequired)
    ),
    externalUrl: Yup.string()
      .test(
        'valid-url',
        intl.formatMessage(messages.validationApplicationUrl),
        isValidURL
      )
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationApplicationUrlTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    baseUrl: Yup.string()
      .test(
        'leading-slash',
        intl.formatMessage(messages.validationBaseUrlLeadingSlash),
        (value) => !value || value.startsWith('/')
      )
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationBaseUrlTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
  });

  const testConnection = useCallback(
    async ({
      hostname,
      port,
      apiKey,
      baseUrl,
      useSsl = false,
    }: {
      hostname: string;
      port: number;
      apiKey: string;
      baseUrl?: string;
      useSsl?: boolean;
    }) => {
      setIsTesting(true);
      try {
        const response = await axios.post<BookshelfTestResponse>(
          '/api/v1/settings/bookshelf/test',
          {
            hostname,
            apiKey,
            port: Number(port),
            baseUrl,
            useSsl,
          }
        );

        setIsValidated(true);
        setTestResponse(response.data);
        if (initialLoad.current) {
          addToast(intl.formatMessage(messages.toastBookshelfTestSuccess), {
            appearance: 'success',
            autoDismiss: true,
          });
        }
      } catch {
        setIsValidated(false);
        if (initialLoad.current) {
          addToast(intl.formatMessage(messages.toastBookshelfTestFailure), {
            appearance: 'error',
            autoDismiss: true,
          });
        }
      } finally {
        setIsTesting(false);
        initialLoad.current = true;
      }
    },
    [addToast, intl]
  );

  useEffect(() => {
    if (bookshelf) {
      testConnection({
        apiKey: bookshelf.apiKey,
        hostname: bookshelf.hostname,
        port: bookshelf.port,
        baseUrl: bookshelf.baseUrl,
        useSsl: bookshelf.useSsl,
      });
    }
  }, [bookshelf, testConnection]);

  return (
    <Transition
      as="div"
      appear
      show
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Formik
        initialValues={{
          name: bookshelf?.name ?? '',
          mediaType: bookshelf?.mediaType ?? 'audiobook',
          hostname: bookshelf?.hostname ?? '',
          port: bookshelf?.port ?? 8787,
          ssl: bookshelf?.useSsl ?? false,
          apiKey: bookshelf?.apiKey ?? '',
          baseUrl: bookshelf?.baseUrl ?? '',
          activeProfileId: bookshelf?.activeProfileId ?? '',
          activeMetadataProfileId: bookshelf?.activeMetadataProfileId ?? '',
          rootFolder: bookshelf?.activeDirectory ?? '',
          isDefault: bookshelf?.isDefault ?? false,
          externalUrl: bookshelf?.externalUrl ?? '',
          syncEnabled: bookshelf?.syncEnabled ?? false,
          enableSearch: !bookshelf?.preventSearch,
        }}
        validationSchema={BookshelfSettingsSchema}
        onSubmit={async (values) => {
          try {
            const profileName = testResponse.profiles.find(
              (p) => p.id === Number(values.activeProfileId)
            )?.name;
            const metadataProfileName = testResponse.metadataProfiles.find(
              (p) => p.id === Number(values.activeMetadataProfileId)
            )?.name;

            const submission = {
              name: values.name,
              mediaType: values.mediaType,
              hostname: values.hostname,
              port: Number(values.port),
              apiKey: values.apiKey,
              useSsl: values.ssl,
              baseUrl: values.baseUrl,
              activeProfileId: Number(values.activeProfileId),
              activeProfileName: profileName,
              activeMetadataProfileId: Number(values.activeMetadataProfileId),
              activeMetadataProfileName: metadataProfileName,
              activeDirectory: values.rootFolder,
              tags: [] as number[],
              is4k: false,
              isDefault: values.isDefault,
              externalUrl: values.externalUrl,
              syncEnabled: values.syncEnabled,
              preventSearch: !values.enableSearch,
              tagRequests: false,
              overrideRule: [] as number[],
            };
            if (!bookshelf) {
              await axios.post('/api/v1/settings/bookshelf', submission);
            } else {
              await axios.put(
                `/api/v1/settings/bookshelf/${bookshelf.id}`,
                submission
              );
            }
            onSave();
          } catch {
            // toast is handled at the test step; submit failures fall through
          }
        }}
      >
        {({
          errors,
          touched,
          values,
          handleSubmit,
          setFieldValue,
          isSubmitting,
          isValid,
        }) => (
          <Modal
            onCancel={onClose}
            okButtonType="primary"
            okText={
              isSubmitting
                ? intl.formatMessage(globalMessages.saving)
                : bookshelf
                  ? intl.formatMessage(globalMessages.save)
                  : intl.formatMessage(messages.add)
            }
            secondaryButtonType="warning"
            secondaryText={
              isTesting
                ? intl.formatMessage(globalMessages.testing)
                : intl.formatMessage(globalMessages.test)
            }
            onSecondary={() => {
              if (values.apiKey && values.hostname && values.port) {
                testConnection({
                  apiKey: values.apiKey,
                  baseUrl: values.baseUrl,
                  hostname: values.hostname,
                  port: values.port,
                  useSsl: values.ssl,
                });
                if (!values.baseUrl || values.baseUrl === '/') {
                  setFieldValue('baseUrl', testResponse.urlBase);
                }
              }
            }}
            secondaryDisabled={
              !values.apiKey ||
              !values.hostname ||
              !values.port ||
              isTesting ||
              isSubmitting
            }
            okDisabled={!isValidated || isSubmitting || isTesting || !isValid}
            onOk={() => handleSubmit()}
            title={
              !bookshelf
                ? intl.formatMessage(messages.createbookshelf)
                : intl.formatMessage(messages.editbookshelf)
            }
          >
            <div className="mb-6">
              <div className="form-row">
                <label htmlFor="isDefault" className="checkbox-label">
                  {intl.formatMessage(messages.defaultserver)}
                </label>
                <div className="form-input-area">
                  <Field type="checkbox" id="isDefault" name="isDefault" />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="mediaType" className="text-label">
                  {intl.formatMessage(messages.mediaType)}
                  <span className="label-required">*</span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.mediaTypeHelp)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field as="select" id="mediaType" name="mediaType">
                      <option value="audiobook">
                        {intl.formatMessage(messages.mediaTypeAudiobook)}
                      </option>
                      <option value="ebook">
                        {intl.formatMessage(messages.mediaTypeEbook)}
                      </option>
                    </Field>
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="name" className="text-label">
                  {intl.formatMessage(messages.servername)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="name"
                      name="name"
                      type="text"
                      autoComplete="off"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setIsValidated(false);
                        setFieldValue('name', e.target.value);
                      }}
                    />
                  </div>
                  {errors.name &&
                    touched.name &&
                    typeof errors.name === 'string' && (
                      <div className="error">{errors.name}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="hostname" className="text-label">
                  {intl.formatMessage(messages.hostname)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <span className="protocol">
                      {values.ssl ? 'https://' : 'http://'}
                    </span>
                    <Field
                      id="hostname"
                      name="hostname"
                      type="text"
                      inputMode="url"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setIsValidated(false);
                        setFieldValue('hostname', e.target.value);
                      }}
                      className="rounded-r-only"
                    />
                  </div>
                  {errors.hostname &&
                    touched.hostname &&
                    typeof errors.hostname === 'string' && (
                      <div className="error">{errors.hostname}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="port" className="text-label">
                  {intl.formatMessage(messages.port)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <Field
                    id="port"
                    name="port"
                    type="text"
                    inputMode="numeric"
                    className="short"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setIsValidated(false);
                      setFieldValue('port', e.target.value);
                    }}
                  />
                  {errors.port &&
                    touched.port &&
                    typeof errors.port === 'string' && (
                      <div className="error">{errors.port}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="ssl" className="checkbox-label">
                  {intl.formatMessage(messages.ssl)}
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="ssl"
                    name="ssl"
                    onChange={() => {
                      setIsValidated(false);
                      setFieldValue('ssl', !values.ssl);
                    }}
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="apiKey" className="text-label">
                  {intl.formatMessage(messages.apiKey)}
                  <span className="label-required">*</span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.apiKeyHelp)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      id="apiKey"
                      name="apiKey"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setIsValidated(false);
                        setFieldValue('apiKey', e.target.value);
                      }}
                    />
                  </div>
                  {errors.apiKey &&
                    touched.apiKey &&
                    typeof errors.apiKey === 'string' && (
                      <div className="error">{errors.apiKey}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="baseUrl" className="text-label">
                  {intl.formatMessage(messages.baseUrl)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.baseUrlHelp)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="baseUrl"
                      name="baseUrl"
                      type="text"
                      inputMode="url"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setIsValidated(false);
                        setFieldValue('baseUrl', e.target.value);
                      }}
                    />
                  </div>
                  {errors.baseUrl &&
                    touched.baseUrl &&
                    typeof errors.baseUrl === 'string' && (
                      <div className="error">{errors.baseUrl}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="activeProfileId" className="text-label">
                  {intl.formatMessage(messages.qualityprofile)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      as="select"
                      id="activeProfileId"
                      name="activeProfileId"
                      disabled={!isValidated || isTesting}
                    >
                      <option value="">
                        {isTesting
                          ? intl.formatMessage(messages.loadingprofiles)
                          : !isValidated
                            ? intl.formatMessage(
                                messages.testFirstQualityProfiles
                              )
                            : intl.formatMessage(messages.selectQualityProfile)}
                      </option>
                      {testResponse.profiles
                        .toSorted((a, b) =>
                          a.name.localeCompare(b.name, intl.locale, {
                            numeric: true,
                            sensitivity: 'base',
                          })
                        )
                        .map((profile) => (
                          <option
                            key={`profile-${profile.id}`}
                            value={profile.id}
                          >
                            {profile.name}
                          </option>
                        ))}
                    </Field>
                  </div>
                  {errors.activeProfileId &&
                    touched.activeProfileId &&
                    typeof errors.activeProfileId === 'string' && (
                      <div className="error">{errors.activeProfileId}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="activeMetadataProfileId" className="text-label">
                  {intl.formatMessage(messages.metadataprofile)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      as="select"
                      id="activeMetadataProfileId"
                      name="activeMetadataProfileId"
                      disabled={!isValidated || isTesting}
                    >
                      <option value="">
                        {isTesting
                          ? intl.formatMessage(messages.loadingprofiles)
                          : !isValidated
                            ? intl.formatMessage(
                                messages.testFirstQualityProfiles
                              )
                            : intl.formatMessage(
                                messages.selectMetadataProfile
                              )}
                      </option>
                      {testResponse.metadataProfiles
                        .toSorted((a, b) =>
                          a.name.localeCompare(b.name, intl.locale, {
                            numeric: true,
                            sensitivity: 'base',
                          })
                        )
                        .map((mp) => (
                          <option key={`metaprofile-${mp.id}`} value={mp.id}>
                            {mp.name}
                          </option>
                        ))}
                    </Field>
                  </div>
                  {errors.activeMetadataProfileId &&
                    touched.activeMetadataProfileId &&
                    typeof errors.activeMetadataProfileId === 'string' && (
                      <div className="error">
                        {errors.activeMetadataProfileId}
                      </div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="rootFolder" className="text-label">
                  {intl.formatMessage(messages.rootfolder)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      as="select"
                      id="rootFolder"
                      name="rootFolder"
                      disabled={!isValidated || isTesting}
                    >
                      <option value="">
                        {isTesting
                          ? intl.formatMessage(messages.loadingprofiles)
                          : !isValidated
                            ? intl.formatMessage(
                                messages.testFirstQualityProfiles
                              )
                            : intl.formatMessage(messages.selectRootFolder)}
                      </option>
                      {testResponse.rootFolders.map((folder) => (
                        <option
                          key={`rootfolder-${folder.id}`}
                          value={folder.path}
                        >
                          {folder.path}
                        </option>
                      ))}
                    </Field>
                  </div>
                  {errors.rootFolder &&
                    touched.rootFolder &&
                    typeof errors.rootFolder === 'string' && (
                      <div className="error">{errors.rootFolder}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="externalUrl" className="text-label">
                  {intl.formatMessage(messages.externalUrl)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.externalUrlHelp)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="externalUrl"
                      name="externalUrl"
                      type="text"
                      inputMode="url"
                    />
                  </div>
                  {errors.externalUrl &&
                    touched.externalUrl &&
                    typeof errors.externalUrl === 'string' && (
                      <div className="error">{errors.externalUrl}</div>
                    )}
                </div>
              </div>
            </div>
          </Modal>
        )}
      </Formik>
    </Transition>
  );
};

export default BookshelfModal;
