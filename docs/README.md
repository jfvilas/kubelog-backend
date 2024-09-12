# Backstage Kubelog plugin backend
This Backstage plugin is the backend for the Kubelog (Kubernetes log viewing) frontend plugin.

***NOTE*: Please refer to [Kubelog Plugin](https://github.com/jfvilas/kubelog) general info to understand what is Kubelog, what are its requirements and how does it work.**

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

## Configure
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
2. The API Key should be 'permanent', the scope has to be 'cluster' and set the expire term long enough. When the API Key has been created, copy the API Key that Kwirth will create for you and is displayed at the API Key list.

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
- kubelogKwirthHome: the home URL of the Kwirth installation.
- kubelogKwirthApiKey: The API key we created before.

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
+         kubelogKwirthHome: http://your-external.dns.name/kwirth
+         kubelogKwirthApiKey: '40f5ea6c-bac3-df2f-d184-c9f3ab106ba9|permanent|cluster::::'
          authProvider: 'serviceAccount'
          skipTLSVerify: true
          skipMetricsLookup: true
```

### 4. Permissions

#### Introduction to the permission system
The permission system of Kubelog has been designed with these main ideas in mind:

  - **Keep it simple**, that is, people that don't want to get complicated should be able to configure permissions without a headache, using just a few lines (in some cases even with 0 lines)
  - It must be **flexible**. Because *every house is a world*, the system should be flexible enough to accomodate every single permission need whatever its size be.

So, the permission system has been build using (right now) two layers:

  1. **Namespace layer**. Assigning permissions to whole namespaces can be done in a extremely simple way using this layer.
  2. **Pod layer**. If namespace permission layer is not coarse enough for you, you can refine your permissions by using the pod permission layer which, in addition, adds scopes to the different permissions you can assign.


#### Namespace layer
Let's suppose that in your clusters you have 3 namespaces:
  - dev, for development workloads
  - stage: for canary deployments, a/b testing and so on 
  - production: for productive workloads

Typically you would restrict access to logs in such a way that:
  - Everybody should be able to view developoment (dev) logs.
  - Only Operations teams and administrators can view preproduction (stage) logs.
  - Only administrators can see production logs. In addition to administrators, production can also be accesseed by Nicklaus Wirth.

The way you can manage this in Kubelog is via Group entities of Backstage. That is:
  - You create a group where you add all your developers.
  - Another group with your devops team.
  - And a group containing just the administrators.

**NOTE**: for simplicity we assume all your User refs and Group refs live in a Backstage namespace named 'default'

Once you have created the groups you can configure the namespace permission adding one additional property to the cluster definition, it is named '**kubelogNamespacePermissions**'. This is an array of namespaces, where for each namespace you can declare an array of identity refs (that is, users or groups). The example below is self-explaining.

```diff
      clusters:
        - url: https://kuebeapi.your-cluster.com
          name: k3d-cluster
          title: 'Kubernetes local'
          kubelogKwirthHome: http://your-external.dns.name/kwirth
          kubelogKwirthApiKey: '40f5ea6c-bac3-df2f-d184-c9f3ab106ba9|permanent|cluster::::'
+         kubelogNamespacePermissions:
+           - stage: ['group:default/devops', 'group:default/admin']
+           - production: ['group:default/admin', 'user:default/nicklaus-wirth']
          authProvider: 'serviceAccount'
          skipTLSVerify: true
          skipMetricsLookup: true
```

It's easy to understand:
  1. Everybody can access 'dev' namespace, since we have stated no restrictions at all.
  2. 'stage' namespace can be accessed by group 'devops' and group 'admin'.
  3. The 'production' namespace can be accesed by the group of administrators ('admin') and the user Nicklaus Wirth.
  
Remember, if you don't want to restrict a namespace, just do not add it to the configuration in app-config file, like we have done with 'dev' namespace.

When a user working with Backstage enters Kubelog tab (in the entity page) he will see a list of clusters. If he selects a cluster a list of namespaces will be shown, that is, all namespaces that do contain pods tagged with the current entity id. If the user has no permission to a specific namespace, the namespace will be shown in <span style='color:red'>red</span> and will not be accesible. Allowed namespaced will be shown in <span style='color:blue'>**primary color**</span> and will be 'clickable'.


#### Pod permissions
In addition to namespace permissions, Kubelog has added on version 0.9 a pod permission layer in which you can refine your permissions. Currently **2 scopes** have been defined:

  - **View** scope, for viewing logs.
  - **Restart** scope, for restarting pods.

Each scope has a configuration section in the app-config, but both work exactly the same way, so we will explain just how 'view' scope permissions would be defined.

Let's consider a simple view-scoped pod permission sample based on previously defined namespaces: 'dev', 'stage', 'production':

```diff
      clusters:
        - url: https://kuebeapi.your-cluster.com
          name: k3d-cluster
          title: 'Kubernetes local'
          kubelogKwirthHome: http://your-external.dns.name/kwirth
          kubelogKwirthApiKey: '40f5ea6c-bac3-df2f-d184-c9f3ab106ba9|permanent|cluster::::'
+         kubelogNamespacePermissions:
+           - stage: ['group:default/devops', 'group:default/admin']
+           - production: ['group:default/admin', 'user:default/nicklaus-wirth']
          authProvider: 'serviceAccount'
          skipTLSVerify: true
          skipMetricsLookup: true
+         kubelogPodViewPermissions:
+           - stage:
+               allow:
+               - pods: [^common-]
+               - pods: [keys]
+                 refs: []
+               - pods: [^ef.*]
+                 refs: [group:.+/admin, group:test/.+]
+               - pods: [th$]
+                 refs: [.*]
+               except:
+               - pods: [kwirth]
+                 refs: [group:default/admin, user:defualt:nicklaus-wirth]
+           - production
+               deny:
+               - refs: [.*]
+           - others
+               allow:
+               - refs: []
          ...
```

***VERY IMPORTANT NOTE:*** **All strings defined in the pod permission layer are regular expressions**

About this example and about 'how to configure kubelog pod permissions':

  - **kubelogPodViewPermissions** is the section name for refining pod permission for viewing logs.
  - The main content of this section is a list of namespaces (like 'dev' in the sample).
  - The content of each namespace is a rule system that works this way:
    - Rules can be defined following a fixed schema by which you can **allow** or **deny** access to a set of pods to a set of identity references (users or groups)
    - 'allow' can be refined by adding exceptions by means of 'except' keyword.
    - 'deny' can be refined by adding exceptions by means of 'unless' keyword.
    - The order of evaluation of rules is:
       1. Search for a pod name match in the allow section.
       2. If a match is found, look for any exception that may be applied, by searching for matches in the 'except' section.
       3. If no 'allow' is found, or an allow rule is found but there exists an except rule that matches, the access is not granted and the process finishes here.
       4. If the user is granted, Kubelog then looks for a match in the 'deny' section.
       5. If there are no deny rules that match, the user is granted and the process finsihes here.
       6. If a deny rule matches, then Kueblog will search for any 'unless' rule that matches. I no unless rule match exists, the access is denied and the process finishes here.
       7. If there exists an 'unless' rule then the access is granted.
    - It's important to note that 'allow' and 'deny' are optional, but if you dont specify them, they will match anything.
 - It is most important to know that if a namespace is not spscified, the access is granted.

So, in our example:
  - Access to 'dev' is granted, since 'dev' namespace is not specified.
  - Access to 'stage' works this way:
    - *Everybody can access pods whose name starts with 'common-'* (remember, **we always use regexes**). We have added no 'refs', so any identity ref matches.
    - *Nobody can access pod named 'keys'* (pay attention to the refs set to '[]', that is no identity ref can access)
    - *Admins and people on namespace 'test' can access any pod whose name starts with 'ef'*. The 'pods' contians a regex with '^ef.*' (starts with 'ef' and contain any number of characters afterwards). The identity refs that can access pods that match with this pod regex are the group of admins on any Backstage namespace ('group:.+/admin') and all the people that belongs to Backstage group 'test' (group:test/.+).
    - *'Everybody can access pods whose name ends with 'th'*. That is, the regex in pods is 'th$' (names ending with 'th'), and the refs contains '.*', that is, any number of characters, so there are no limits on the refs, everybody is included.
    - *But... if the pod name is 'kwirth' only admis can access*. This refers to the 'except' section, which is a refinement of the allow. Although the previous rule says *everybody acan access pods ending with 'th'*, this is true **except** for the pod name 'kwirth', which can only be accesed by 'admins in the default' group or 'Nicklaus Wirth'.

Let's complete the example with the other namespaces declared:
  - *Nobody can access pods in 'production' namespace*. The 'production' namespace doesn't have an 'allow' section, it ony contains a 'deny'. In addition, the 'deny' section only contains a 'refs' section (all pod names would match, since no 'pods' section means 'pods: [.*]', that is, all pod names match). The 'refs' inside the 'deny' contains '.*', what means every ref would match, so, finally, *nobody can access a pod*.
  - *Nobody can access pods in 'others' namespace*. The 'others' namespace contains just an 'allow' rule, which have no pods (so all pod names would match), and it contains in the 'refs' this expression: '[]', so no identity ref would match. Finally, *nobody can access a pod*, the same as 'production' but achieved in other way.

Please be aware that not declaring 'pods' or 'refs' means using a **match-all** approach (by using ['.*']), what is completely different than declaring '[]', what **matches nothing**.


#### Pod permission scopes
Starting with **Kubelog 0.9**, there exist two scopes (that are consistent with Kwirth scopes):

  - 'view' scope, for viewing logs
  - 'restart' scope, for restarting pods

The permissions related with this two scopes can be declared in app-config using these tow sections:

  - **kubelogPodViewPermissions**, the same as the sample we show before, it's for viewing logs.
  - **kubelogPodRestartPermissions**, for restarting pods.

The way the permissions are declared is the one explained before, with this general structure inside app-config YAML:

```yaml
  - SCOPE:
    - NAMESPACE:
      - allow:
        - pods: [...]
          refs: [...]
      - except:
      - deny:
      - unless:
    - NAMESPACE:
      - allow:
      - ...
  - SCOPE:
    - NAMESPACE:
      ...
```

Where:
  - SCOPE is one of 'kubelogPodViewPermissions' or 'kubelogPodRestartPermissions'.
  - NAMESPACE is the name (not a regex, I mean exactly the name) of a namespace.
  - 'allow', 'except', 'deny' and 'unless' contain arrays of objects, where each one object has only two properties: 'pods' and 'refs'.
    - 'pods' is an array of regex that will be evaluated against pod names.
    - 'refs' is an array of regex that will be evaluated against Backstage identity references, where the format is the following one:
      - General syntax is '**type:namespace/id**',
      - 'type' is one of 'user' or 'group',
      - 'namespace' is a Backstage namespace.
      - 'id' is a reference id, like a user name or a group name.
  - You can repeat NAMESPACE, in order to have different sections make your config readable if you have lots of rules.
