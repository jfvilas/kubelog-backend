# Backstage Kubelog plugin backend

This Backstage plugin is the backend for the Kubelog (Kubernetes log viewing) frontend plugin.

***NOTE*: Please refer to [Kubelog Plugin](https://github.com/jfvilas/kubelog) general info to understand what is Kubelog, what are the requirements and how do it works.**

This [Backstage]((https://backstage.io)) backend plugin is primarily responsible for the following tasks:

- Reading Kueblog config from app-config

- Validating login processes to remote Kwirth instances, and thus obtaining valid API keys for user.

## Install

### Up and Running
Here's how to get the backend up and running quickly. First we need to add the `@jfvilas/plugin-kubelog-backend` package to your backend:

```sh
# From your Backstage root directory
yarn --cwd packages/backend add @jfvilas/plugin-kubelog-backend @jfvilas/plugin-kubelog-common
```

### New Backend System (old backend system has been omitted)
Next you need to modify your backend index file. In your `packages/backend/src/index.ts` make the following change:
```diff
    const backend = createBackend();

    // ... other feature additions

+   backend.add(import('@jfvilas/plugin-kubelog-backend'));

    // ... other feature additions

    backend.start();
```

## Configuration
To have a Kubelog up and running you must perform some previous additional tasks, like deploying Kwirth, creating API Keys, defining clusters, etc... In this section we cover all this needs in a structured way.

Remember, Backstage Kubelog plugin helps you in showing logs inside Backstage to ease your develoment teams work, but this plugin has no access to the logs in itself, it relies on Kwirth to act as a "log proxy", that is, Kwirth (a component that runs inside your Kubernetes clusters) has access to logs and can "export" them outside the cluster in a secure way, so logs can be consumed anywhere. For example, logs can be shown on Backstage entity pages.

### 1. Kwirth installation
We will not cover this subject here, we refer you to [Kwirth installation documentation](https://jfvilas.github.io/kwirth/#/installation) where you will find more information on how Kwirth works and how to install it. We show here just a summary of what is Kwirth:

1. Kwirth is built around the **one-only-pod concept**.
2. Kwirth doesn't need any persistenace layer (no database, no network storage, no block storage, no file storage). It uses only Kubernetes storage.
3. Kwirth provides user management, API security and multi-cluster access.
4. Kwirth can export **log information in real-time** wherever you need it.

### 2. Kwirth customization
Once you have a Kubernetes cluster with a Kwirth installation in place (to export logs Kwirth must be accesible from outside your cluster, so you will need to install any flavour of Ingress Controller and an Ingress for publishing Kwirth access). Please **write down your Kwirt external access** (we will need it for configuring Kubelog). For this tutorial we will assume your Kwirth is published on: **http://your-external.dns.name/kwirth**.

Once Kwirth is running perform there two simple actions:
1. Login to your Kwirth and access to the [API Key section](https://jfvilas.github.io/kwirth/#/apimanagement?id=api-management) to create an API Key that we need for enabling Kubelog to access Kwirth.
2. The API Key should be 'permanent', the scope has to be 'cluster' and set the expire term long enough. When the API Key has been created, copy the API Key that Kwrith will create for you and is displayed at the API Key list.

This is all you need to do inside Kwirth.

### 3. Backstage configuration
For finishing Kubelog config you need to edit your app-config.yaml in order to add Kwirth information to your Kubernetes cluster. Kubelog doesn't have a specific section in the app-config, it just uses the Backstage Kubernetes core component configuration vitamined with some additional properties. Let's suppose you have a Kubernetes configuration like this in your current app-config:

```yaml
kubernetes:
  serviceLocatorMethod:
    type: 'multiTenant'
  clusterLocatorMethods:
    - type: 'config'
      clusters:
        - url: https://kuebeapi.your-cluster.com
          name: k3d-cluster
          title: 'Kubernetes local'
          authProvider: 'serviceAccount'
          skipTLSVerify: true
          skipMetricsLookup: true
```

We need to add 2 properties to the cluster configuration:
- kwirthHome: the home URL of the Kwirth installation.
- kwirthApiKey: The API key we created before.

The kubernetes section should look something like this:
```diff
kubernetes:
  serviceLocatorMethod:
    type: 'multiTenant'
  clusterLocatorMethods:
    - type: 'config'
      clusters:
        - url: https://kuebeapi.your-cluster.com
          name: k3d-cluster
          title: 'Kubernetes local'
+         kwirthHome: http://your-external.dns.name/kwirth
+         kwirthApiKey: '40f5ea6c-bac3-df2f-d184-c9f3ab106ba9|permanent|cluster::::'
          authProvider: 'serviceAccount'
          skipTLSVerify: true
          skipMetricsLookup: true
```

### 4. Permissions
Let's suppose that in your clusters you have 3 namespaces:
  - dev, for development workloads
  - stage: for canary deployments, a/b testing and so in 
  - producion: for productive workloads

Typically you would restrict access to logs in such a way that:
  - Everybody acan view developoment logs.
  - Only Operations temas and administrators can view Stage logs.
  - Ony administrators can see production logs. In addition to administrators, productin can also be accesseed by Nicklaus Wirth.

The way you can mnage this in Kubelog is via Group entities of Backstage. That is:
  - You create a group where you add all your developers.
  - Another group with your devops team.
  - And a group containing just the administrators.

**NOTE**: for simplicity we assume all your User refs and Group refs live in a Backstage namespace named 'default'

Once you have created the groups you can configute the namespace permission adding one additioal pooperty to the cluster definition, it is names : kwirthNamespacePermissions. This is an array of namespaces, where for each namespace you must declare an array of identity refs (that is, users or groups). The example below is self-explaining.

```diff
      clusters:
        - url: https://kuebeapi.your-cluster.com
          name: k3d-cluster
          title: 'Kubernetes local'
          kwirthHome: http://your-external.dns.name/kwirth
          kwirthApiKey: '40f5ea6c-bac3-df2f-d184-c9f3ab106ba9|permanent|cluster::::'
+         kwirthNamespacePermissions:
+           - stage: ['group:default/devops', 'group:default/admin']
+           - production: ['group:default/admin', 'user:default/nicklaus-wirth']
          authProvider: 'serviceAccount'
          skipTLSVerify: true
          skipMetricsLookup: true
```

It's easy to understand. Remember, if you don't want to restrict a namespace, just do not add it to the configuration app-config file, like we have done  with 'dev' namespace.
