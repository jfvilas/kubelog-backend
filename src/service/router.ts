/*
Copyright 2024 Julio Fernandez

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import express from 'express';
import Router from 'express-promise-router';
import { AuthService, BackstageUserInfo, CacheService, DiscoveryService, HttpAuthService, LoggerService, RootConfigService, UrlReaderService, UserInfoService } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { UserEntity } from '@backstage/catalog-model';
import { FetchApi } from '@backstage/core-plugin-api';

// Kubelog
import { Resources } from '@jfvilas/plugin-kubelog-common';
import { loadClusters } from './config';
import { KubelogStaticData } from '../model/KubelogStaticData';

export type KubelogRouterOptions = {
  discovery: DiscoveryService;
  config: RootConfigService;
  reader: UrlReaderService;
  cache: CacheService;
  logger: LoggerService;
  userInfo: UserInfoService;
  auth: AuthService;
  httpAuth: HttpAuthService;
};

/**
 * 
 * @param options core services we need for kubelog to work
 * @returns an express Router
 */
async function createRouter(options: KubelogRouterOptions): Promise<express.Router> {
    const { config, logger, userInfo, auth, httpAuth, discovery } = options;

    logger.info('Loading static config');

    if (!config.has('kubernetes.clusterLocatorMethods')) {
        logger.error(`Kueblog will not start, there is no 'clusterLocatorMethods' defined in app-config.`);
        throw new Error('Kueblog backend will not be available.');
    }
    loadClusters(logger, config);
    logger.info('Static config loaded');
    if (config.subscribe) {
        config.subscribe( () => {
            logger.warn('Change detected on app-config, Kubelog will update config.');
            loadClusters(logger, config);
        });
    }
    else {
        logger.info('Kubelog cannot subscribe to config changes.');
    }

  const router = Router();
  router.use(express.json());

  // we need this function to be able to invoke another backend plugin passing an authorization token
  const createAuthFetchApi = (token: string): FetchApi => {
    return {
      fetch: async (input, init) => {
        init = init || {};
        init.headers = {
          ...init.headers,
          Authorization: `Bearer ${token}`,
        };
        return fetch(input, init);
      },
    };
  };

  /**
   * Invokes Kwirth to obtain a list of pods that are tagged with the kubernetes-id of the entity we are looking for.
   * @param entityName name of the tagge dentity
   * @returns a Resources[] (each Resources is list of pods in a cluster).
   */
  const getValidResources = async (entityName:string) => {
    var resourceList:Resources[]=[];

    for (const name of KubelogStaticData.clusterKubelogData.keys()) {
      var url=KubelogStaticData.clusterKubelogData.get(name)?.home as string;
      var apiKey=KubelogStaticData.clusterKubelogData.get(name)?.apiKey;
      var title=KubelogStaticData.clusterKubelogData.get(name)?.title;
      var queryUrl=url+`/managecluster/find?label=backstage.io%2fkubernetes-id&entity=${entityName}`;
      var fetchResp = await fetch (queryUrl, {headers:{'Authorization':'Bearer '+apiKey}});
      var jsonResp=await fetchResp.json();
      if (jsonResp) resourceList.push({ name, url, title, data:jsonResp });
    }

    return resourceList;
  }

  /**
   * This function obtains an accesskey for streaming a concrete log in a specific pod
   * @param clusterName the name of the cluster
   * @param entityName the name of the Backstage entity we are streaming for
   * @param kwirthResource the Resource ID that identifies the log we want to stream
   * @param userName the name of the Backstage user (for logging purposes inside Kwirth)
   * @returns a Kwirth accessKey
   */
  const getAccessKey = async (clusterName:string, entityName:string, kwirthResource:string, userName:string) => {
    var url=KubelogStaticData.clusterKubelogData.get(clusterName)?.home as string;
    var apiKey=KubelogStaticData.clusterKubelogData.get(clusterName)?.apiKey;

    var payload={ type:'volatile', resource: kwirthResource, description:`Backstage API key for user ${userName} accessing component ${entityName}`, expire:Date.now()+60*60*1000};
    var response=await fetch(url+'/key',{method:'POST', body:JSON.stringify(payload), headers:{'Content-Type':'application/json', Authorization:'Bearer '+apiKey}});
    var data=await response.json();
    return data.accessKey;
  }

  /**
   * Adds access keys to the list of kubernetes resources related with the entity
   * @param resourcesList current list of resources (whcih have no access keys yet)
   * @param entityName name of the entoty we want to stream logs
   * @param userEntityRef a user entoty ref for the current user ('user:group/id')
   * @param userGroups a list of the IAM groups the user belongs to
   * @returns the resource l ist populated with access keys that the user is permitted to use
   */
  const addAccessKeys = async (resourcesList:Resources[], entityName:string, userEntityRef:string, userGroups:string[]) => {
    var principal=userEntityRef.split(':')[1];
    var username=principal.split('/')[1];

    for (var cluster of resourcesList) {
      var clusterKwirthRules=KubelogStaticData.clusterKubelogData.get(cluster.name)?.namespacePermissions;

      for (var pod of cluster.data) {
        var rule=clusterKwirthRules?.find(ns => ns.namespace===pod.namespace);
        var allowed=false;
        if (rule) {
          if (rule.identityRefs.includes(userEntityRef.toLowerCase())) {
            // a user ref has been found
            allowed=true;
          }
          else {
            var joinResult=rule?.identityRefs.filter(identityRef => userGroups.includes(identityRef));
            if (joinResult && joinResult.length>0) {
              // a group ref match has been found
              allowed=true;
            }
          }
        }
        else {
          // no restrictions for this namespace
          allowed=true;
        }
        if (allowed) {
          var kwirthResource=`filter:${pod.namespace}::${pod.name}:`;
          pod.accessKey=await getAccessKey(cluster.name, entityName, kwirthResource, username);          
        }
      }
    }
    return resourcesList;
  }

  /**
   * builds a list of groups (expressed as identity refs) that the user belongs to.
   * @param userInfo Backstage user info of the user to search groups for
   * @returns an array of group refs in canonical form
   */
  const getUserGroups = async (userInfo:BackstageUserInfo) => {
    const { token } = await auth.getPluginRequestToken({
        onBehalfOf: await auth.getOwnServiceCredentials(),
        targetPluginId: 'catalog'
    });
    const catalogClient = new CatalogClient({
        discoveryApi: discovery,
        fetchApi: createAuthFetchApi(token),
    });

    const entity = await catalogClient.getEntityByRef(userInfo.userEntityRef) as UserEntity;
    var userGroupsRefs:string[]=[];
    if (entity?.spec.memberOf) userGroupsRefs=entity?.spec.memberOf;  
    return userGroupsRefs;
  }


  // this endpoints receives entity from the kubelog plugin and builds a list of resurces with api keys
  router.post('/start', async (req, res) => {
    // obtain basic user info
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const info = await userInfo.getUserInfo(credentials);

    // get user groups list
    var userGroupsRefs=await getUserGroups(info);

    // get a resource list
    //+++ control error here (maybe we cannot conntact the cluster, for example)
    var resourcesList:Resources[]=await getValidResources(req.body.metadata.name);

    // add access keys to authorized resources (according to group memberships and kubelog config in app-config)
    resourcesList=await addAccessKeys(resourcesList, req.body.metadata.name, info.userEntityRef, userGroupsRefs);

    res.status(200).send(resourcesList);
  });

  return router;
}

export { createRouter }