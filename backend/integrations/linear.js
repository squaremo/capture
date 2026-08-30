const LINEAR_API_URL = 'https://api.linear.app/graphql'

const CREATE_ISSUE_MUTATION = `
  mutation CreateIssue($teamId: String!, $title: String!, $description: String) {
    issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
      success
      issue { url title }
    }
  }
`

export async function createLinearTask({ apiKey, teamId, title, description }) {
  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    // Linear personal API keys go in Authorization as-is, no "Bearer" prefix.
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({
      query: CREATE_ISSUE_MUTATION,
      variables: { teamId, title, description },
    }),
  })

  if (!res.ok) throw new Error(`Linear API error: ${res.status}`)

  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(`Linear API error: ${errors[0].message}`)
  if (!data.issueCreate.success) throw new Error('Linear issue creation failed')

  return data.issueCreate.issue
}
