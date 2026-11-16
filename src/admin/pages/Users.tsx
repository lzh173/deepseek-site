import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { IconButton } from '../../components/base/IconButton.js'
import { IconEditOutline16, IconTrashOutline16 } from '../../components/base/icons.js'
import { Modal } from '../../components/base/Modal.js'
import { Select } from '../../components/base/Select.js'
import { showToast } from '../../components/base/toastState.js'
import {
  api,
  errorMessage,
  type Grant,
  type MatrixRow,
  type Model,
  type Role,
  type User,
} from '../api.js'
import { Card } from '../components/Card.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'
import { EmptyState, ErrorState } from '../components/EmptyState.js'
import { Field, FormGrid, Input, Switch } from '../components/forms.js'
import { PageHeader } from '../components/PageHeader.js'
import { Skeleton } from '../components/Skeleton.js'
import { Tag } from '../components/Tag.js'
import { copy } from '../copy.js'
import { fromLocalInput, toLocalInput } from '../format.js'
import ui from '../components/ui.module.css'
import styles from './Users.module.css'

/** 编辑中的授权：expires_at 是 <input type="datetime-local"> 的本机时间串，空串表示永久 */
type GrantDraft = {
  model_id: string
  key_id: string
  expires_at: string
}

type KeyGroup = {
  key_id: string
  key_label: string
  channel_name: string
  upstream: string[]
  enabled: boolean
}

const toDraft = (grant: Grant): GrantDraft => ({
  model_id: grant.model_id,
  key_id: grant.key_id,
  expires_at: toLocalInput(grant.expires_at),
})

const groupMatrix = (rows: MatrixRow[]): KeyGroup[] => {
  const map = new Map<string, KeyGroup>()
  for (const row of rows) {
    const current = map.get(row.key_id)
    if (current) {
      current.upstream.push(row.upstream_model)
      current.enabled = current.enabled || row.enabled
      continue
    }
    map.set(row.key_id, {
      key_id: row.key_id,
      key_label: row.key_label,
      channel_name: row.channel_name,
      upstream: [row.upstream_model],
      enabled: row.enabled,
    })
  }
  return [...map.values()]
}

const roleTag = (role: Role) => (
  <Tag tone={role === 'admin' ? 'brand' : 'neutral'}>
    {role === 'admin' ? copy.users.roleAdmin : copy.users.roleUser}
  </Tag>
)

/**
 * 用户页：账号 CRUD + 付费白名单编辑器。
 *
 * 白名单粒度是「Key × 模型」：左边选付费模型，右边从 /models/:id/matrix 列出能承载它的 Key，
 * 勾选后可单独设置到期时间；保存时 PUT 全量替换该用户的授权。
 */
export const Users = () => {
  const [users, setUsers] = useState<User[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [grants, setGrants] = useState<GrantDraft[] | null>(null)
  const [grantsLoading, setGrantsLoading] = useState(false)
  const [grantsVersion, setGrantsVersion] = useState(0)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [matrices, setMatrices] = useState<Record<string, MatrixRow[]>>({})
  const [matrixLoadingId, setMatrixLoadingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [modal, setModal] = useState<{ user: User | null } | null>(null)
  const [deleting, setDeleting] = useState<User | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  /** 当前登录的管理员，用于禁止在表单里把自己降级/停用 */
  const [meId, setMeId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [userResult, modelResult, me] = await Promise.all([
        api.users.list(),
        api.models.list(),
        api.me(),
      ])
      setUsers(userResult.items)
      setModels(modelResult.items)
      setMeId(me.user?.id ?? null)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selectedUserId) {
      setGrants(null)
      return
    }
    let active = true
    setGrantsLoading(true)
    void api.users
      .grants(selectedUserId)
      .then((result) => {
        if (active) {
          setGrants(result.grants.map(toDraft))
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          showToast(errorMessage(caught))
          setGrants([])
        }
      })
      .finally(() => {
        if (active) {
          setGrantsLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [selectedUserId, grantsVersion])

  const loadMatrix = useCallback(async (modelId: string) => {
    setMatrixLoadingId(modelId)
    try {
      const result = await api.models.matrix(modelId)
      setMatrices((prev) => ({ ...prev, [modelId]: result.items }))
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setMatrixLoadingId((current) => (current === modelId ? null : current))
    }
  }, [])

  useEffect(() => {
    if (selectedModelId && matrices[selectedModelId] === undefined) {
      void loadMatrix(selectedModelId)
    }
  }, [selectedModelId, matrices, loadMatrix])

  const selectedUser = users.find((item) => item.id === selectedUserId) ?? null
  const paidModels = models.filter((model) => model.tier === 'paid')
  const selectedModel = paidModels.find((model) => model.id === selectedModelId) ?? null
  const matrixRows = selectedModelId ? (matrices[selectedModelId] ?? []) : []
  const matrixLoaded = selectedModelId ? matrices[selectedModelId] !== undefined : false
  const keyGroups = groupMatrix(matrixRows)
  const matrixLoading = selectedModelId !== null && matrixLoadingId === selectedModelId

  const grantsOfModel = (modelId: string) =>
    (grants ?? []).filter((grant) => grant.model_id === modelId)

  const toggleGrant = (modelId: string, keyId: string, checked: boolean) => {
    setGrants((prev) => {
      const list = prev ?? []
      const exists = list.some((grant) => grant.model_id === modelId && grant.key_id === keyId)
      if (!checked) {
        return list.filter((grant) => !(grant.model_id === modelId && grant.key_id === keyId))
      }
      if (exists) {
        return list
      }
      return [...list, { model_id: modelId, key_id: keyId, expires_at: '' }]
    })
  }

  const setExpiry = (modelId: string, keyId: string, value: string) => {
    setGrants((prev) =>
      (prev ?? []).map((grant) =>
        grant.model_id === modelId && grant.key_id === keyId
          ? { ...grant, expires_at: value }
          : grant
      )
    )
  }

  const setAllOfModel = (modelId: string, keyIds: string[], checked: boolean) => {
    setGrants((prev) => {
      const list = (prev ?? []).filter(
        (grant) => grant.model_id !== modelId || keyIds.includes(grant.key_id)
      )
      if (!checked) {
        return list
      }
      const existing = new Set(
        list.filter((grant) => grant.model_id === modelId).map((grant) => grant.key_id)
      )
      const added = keyIds
        .filter((keyId) => !existing.has(keyId))
        .map((keyId) => ({ model_id: modelId, key_id: keyId, expires_at: '' }))
      return [...list, ...added]
    })
  }

  const saveGrants = async () => {
    if (!selectedUser || grants === null) {
      return
    }
    setSaving(true)
    try {
      const result = await api.users.putGrants(
        selectedUser.id,
        grants.map((grant) => ({
          model_id: grant.model_id,
          key_id: grant.key_id,
          expires_at: fromLocalInput(grant.expires_at),
        }))
      )
      setGrants(result.grants.map(toDraft))
      showToast(copy.users.grantsSaved)
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) {
      return
    }
    setDeletePending(true)
    try {
      await api.users.remove(deleting.id)
      showToast(copy.users.deleted)
      if (selectedUserId === deleting.id) {
        setSelectedUserId(null)
      }
      setDeleting(null)
      await load()
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setDeletePending(false)
    }
  }

  const orphanGrants =
    selectedModelId && matrixLoaded
      ? grantsOfModel(selectedModelId).filter(
          (grant) => !keyGroups.some((group) => group.key_id === grant.key_id)
        )
      : []

  return (
    <>
      <PageHeader
        title={copy.users.title}
        description={copy.users.description}
        actions={
          <>
            <Button variant="outlined" size="m" disabled={loading} onClick={() => void load()}>
              {copy.common.refresh}
            </Button>
            <Button size="m" onClick={() => setModal({ user: null })}>
              {copy.users.create}
            </Button>
          </>
        }
      />

      <div className={styles.layout}>
        <Card
          flush
          className={styles.usersCard}
          title={copy.users.listTitle}
          description={copy.users.listDescription}
        >
          {error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : loading && users.length === 0 ? (
            <div className={styles.userListSkeleton}>
              {[0, 1, 2, 3].map((item) => (
                <Skeleton key={item} height={44} />
              ))}
            </div>
          ) : users.length === 0 ? (
            <EmptyState
              title={copy.users.empty}
              hint={copy.users.emptyHint}
              action={
                <Button size="s" onClick={() => setModal({ user: null })}>
                  {copy.users.create}
                </Button>
              }
            />
          ) : (
            <ul className={styles.userList}>
              {users.map((user) => (
                <li
                  key={user.id}
                  className={styles.userItem}
                  data-selected={user.id === selectedUserId ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className={styles.userButton}
                    onClick={() => setSelectedUserId(user.id)}
                  >
                    <span className={styles.userTop}>
                      <span className={ui.ellipsis}>{user.username}</span>
                      {roleTag(user.role)}
                      {user.enabled ? null : <Tag tone="muted">{copy.common.disabled}</Tag>}
                    </span>
                    <span className={ui.caption}>{copy.users.quotaLabel(user.daily_quota)}</span>
                  </button>
                  <span className={styles.userActions}>
                    <IconButton
                      icon={<IconEditOutline16 />}
                      tooltip={copy.common.edit}
                      onClick={() => setModal({ user })}
                    />
                    <IconButton
                      icon={<IconTrashOutline16 />}
                      tooltip={copy.common.delete}
                      disabled={user.id === meId}
                      onClick={() => setDeleting(user)}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          className={styles.grantsCard}
          title={
            selectedUser ? copy.users.selectedUser(selectedUser.username) : copy.users.grantsTitle
          }
          description={selectedUser ? copy.users.keysDescription : copy.users.grantsEmptyHint}
          actions={
            selectedUser ? (
              <>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={grantsLoading}
                  onClick={() => setGrantsVersion((value) => value + 1)}
                >
                  {copy.users.reload}
                </Button>
                <Button
                  size="s"
                  disabled={saving || grantsLoading || grants === null}
                  onClick={() => void saveGrants()}
                >
                  {saving ? copy.common.saving : copy.users.save}
                </Button>
              </>
            ) : null
          }
        >
          {!selectedUser ? (
            <EmptyState title={copy.users.grantsEmpty} hint={copy.users.grantsEmptyHint} />
          ) : grantsLoading && grants === null ? (
            <div className={styles.grantsSkeleton}>
              <Skeleton height={28} />
              <Skeleton height={160} />
            </div>
          ) : (
            <div className={styles.editor}>
              <div className={styles.modelColumn}>
                <div className={ui.caption}>{copy.users.paidModels}</div>
                {paidModels.length === 0 ? (
                  <EmptyState
                    title={copy.users.paidModelsEmpty}
                    hint={copy.users.paidModelsEmptyHint}
                  />
                ) : (
                  <ul className={styles.modelList}>
                    {paidModels.map((model) => {
                      const count = grantsOfModel(model.id).length
                      return (
                        <li key={model.id}>
                          <button
                            type="button"
                            className={styles.modelButton}
                            data-selected={model.id === selectedModelId ? 'true' : undefined}
                            onClick={() => setSelectedModelId(model.id)}
                          >
                            <span className={styles.modelName}>
                              <span className={ui.ellipsis}>{model.display_name}</span>
                              <span className={ui.code}>{model.id}</span>
                            </span>
                            <Tag tone={count > 0 ? 'brand' : 'muted'}>
                              {count > 0 ? copy.users.grantCount(count) : copy.users.noGrant}
                            </Tag>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              <div className={styles.keyColumn}>
                {selectedModel ? (
                  <>
                    <div className={ui.between}>
                      <div>
                        <div className={ui.sectionTitle}>{copy.users.keysTitle}</div>
                        <div className={ui.caption}>
                          {selectedModel.display_name} · {selectedModel.id}
                        </div>
                      </div>
                      <div className={ui.row}>
                        <Button
                          variant="outlined"
                          size="s"
                          disabled={matrixLoading || !matrixLoaded}
                          onClick={() => void loadMatrix(selectedModel.id)}
                        >
                          {copy.users.reloadMatrix}
                        </Button>
                        <Button
                          variant="outlined"
                          size="s"
                          disabled={!matrixLoaded || keyGroups.length === 0}
                          onClick={() =>
                            setAllOfModel(
                              selectedModel.id,
                              keyGroups.filter((group) => group.enabled).map((group) => group.key_id),
                              true
                            )
                          }
                        >
                          {copy.users.selectAll}
                        </Button>
                        <Button
                          variant="outlined"
                          size="s"
                          disabled={grantsOfModel(selectedModel.id).length === 0}
                          onClick={() =>
                            setAllOfModel(
                              selectedModel.id,
                              keyGroups.map((group) => group.key_id),
                              false
                            )
                          }
                        >
                          {copy.users.clearAll}
                        </Button>
                      </div>
                    </div>

                    {matrixLoading && !matrixLoaded ? (
                      <div className={styles.grantsSkeleton}>
                        <Skeleton height={40} />
                        <Skeleton height={40} />
                      </div>
                    ) : keyGroups.length === 0 ? (
                      <EmptyState title={copy.users.keysEmpty} hint={copy.users.keysEmptyHint} />
                    ) : (
                      <ul className={styles.keyList}>
                        {keyGroups.map((group) => {
                          const granted = grantsOfModel(selectedModel.id).find(
                            (grant) => grant.key_id === group.key_id
                          )
                          return (
                            <li key={group.key_id} className={styles.keyRow}>
                              <label className={styles.keyCheck}>
                                <input
                                  type="checkbox"
                                  className={styles.checkbox}
                                  checked={Boolean(granted)}
                                  /* 已停用的映射不能再勾选，但已有的授权允许取消，否则会卡住保存 */
                                  disabled={!group.enabled && !granted}
                                  onChange={(event) =>
                                    toggleGrant(
                                      selectedModel.id,
                                      group.key_id,
                                      event.currentTarget.checked
                                    )
                                  }
                                />
                                <span className={styles.keyText}>
                                  <span className={ui.ellipsis}>{group.key_label}</span>
                                  <span className={ui.caption}>
                                    {group.channel_name} · {copy.users.upstream}{' '}
                                    {group.upstream.join(' / ')}
                                  </span>
                                </span>
                                {group.enabled ? null : (
                                  <Tag tone="muted">{copy.users.keyDisabled}</Tag>
                                )}
                              </label>
                              {granted ? (
                                <input
                                  type="datetime-local"
                                  className={styles.expiry}
                                  data-empty={granted.expires_at ? undefined : 'true'}
                                  aria-label={copy.users.expiresAt}
                                  title={copy.users.expiryHint}
                                  value={granted.expires_at}
                                  onChange={(event) =>
                                    setExpiry(
                                      selectedModel.id,
                                      group.key_id,
                                      event.currentTarget.value
                                    )
                                  }
                                />
                              ) : (
                                <span className={styles.permanent}>{copy.common.permanent}</span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}

                    {orphanGrants.length > 0 ? (
                      <div className={styles.orphans}>
                        <div className={ui.warning}>{copy.users.orphanTitle}</div>
                        <div className={ui.caption}>{copy.users.orphanHint}</div>
                        <ul className={styles.orphanList}>
                          {orphanGrants.map((grant) => (
                            <li key={grant.key_id} className={styles.orphanRow}>
                              <span className={ui.code}>{grant.key_id}</span>
                              <IconButton
                                icon={<IconTrashOutline16 />}
                                tooltip={copy.users.orphanRemove}
                                onClick={() =>
                                  toggleGrant(selectedModel.id, grant.key_id, false)
                                }
                              />
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <EmptyState title={copy.users.grantsEmpty} hint={copy.users.grantsEmptyHint} />
                )}
              </div>
            </div>
          )}
        </Card>
      </div>

      {modal ? (
        <UserForm
          user={modal.user}
          isSelf={modal.user !== null && modal.user.id === meId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null)
            void load()
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={copy.users.deleteTitle}
          description={copy.users.deleteDescription(deleting.username)}
          busy={deletePending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  )
}

/** 新建/编辑共用一个表单 */
const UserForm = ({
  user,
  isSelf,
  onClose,
  onSaved,
}: {
  user: User | null
  isSelf: boolean
  onClose: () => void
  onSaved: () => void
}) => {
  const [username, setUsername] = useState(user?.username ?? '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>(user?.role ?? 'user')
  const [quota, setQuota] = useState(user ? String(user.daily_quota) : '')
  const [enabled, setEnabled] = useState(user?.enabled ?? true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!user && !username.trim()) {
      setError(copy.common.validation.required)
      return
    }
    if (!user && password.length < 6) {
      setError(copy.common.validation.minPassword)
      return
    }
    if (user && password.length > 0 && password.length < 6) {
      setError(copy.common.validation.minPassword)
      return
    }
    setError(null)
    setSaving(true)
    try {
      const dailyQuota = quota.trim() ? Number(quota.trim()) : undefined
      if (user) {
        await api.users.update(user.id, {
          role,
          enabled,
          ...(dailyQuota === undefined ? {} : { daily_quota: dailyQuota }),
          ...(password.length > 0 ? { password } : {}),
        })
        showToast(copy.users.saved)
      } else {
        await api.users.create({
          username: username.trim(),
          password,
          role,
          ...(dailyQuota === undefined ? {} : { daily_quota: dailyQuota }),
        })
        showToast(copy.users.created)
      }
      onSaved()
    } catch (caught) {
      showToast(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={user ? copy.users.editTitle : copy.users.createTitle}
      closable
      className={styles.dialog}
      mainClassName={styles.dialogMain}
      onClose={() => {
        if (!saving) {
          onClose()
        }
      }}
      footer={
        <>
          <Button variant="outlined" disabled={saving} onClick={onClose}>
            {copy.common.cancel}
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? copy.common.saving : copy.common.save}
          </Button>
        </>
      }
    >
      <FormGrid>
        {error ? (
          <div className={ui.error} role="alert">
            {error}
          </div>
        ) : null}
        <Field label={copy.users.username} wide={!user}>
          <Input
            value={username}
            autoFocus={!user}
            disabled={Boolean(user)}
            spellCheck={false}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.users.password} hint={copy.users.passwordHint}>
          <Input
            value={password}
            type="password"
            autoComplete="new-password"
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
        </Field>
        <Field label={copy.users.role} hint={isSelf ? copy.users.selfHint : undefined}>
          <Select
            ariaLabel={copy.users.role}
            value={role}
            disabled={isSelf}
            options={[
              { value: 'user', label: copy.users.roleUser },
              { value: 'admin', label: copy.users.roleAdmin },
            ]}
            onChange={(value) => setRole(value)}
          />
        </Field>
        <Field label={copy.users.dailyQuota}>
          <Input
            value={quota}
            inputMode="numeric"
            placeholder={copy.users.quotaPlaceholder}
            onChange={(event) => setQuota(event.currentTarget.value)}
          />
        </Field>
        {user ? (
          <Field label={copy.users.enabled} wide>
            <Switch
              checked={enabled}
              disabled={isSelf}
              label={enabled ? copy.common.enabled : copy.common.disabled}
              onChange={setEnabled}
            />
          </Field>
        ) : null}
      </FormGrid>
    </Modal>
  )
}
